'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require uci';
'require view.zapret2.env as env_tools';

var PINS_FILE = '/opt/zapretremix/pins.json';
var PIN_HOSTS_DIR = '/opt/zapretremix/pin-hosts';

// Full per-preset templates (all 3 blocks: HTTP/TLS/QUIC), copied verbatim
// from the actual /opt/zapret2/def-cfg.sh installed this session (NOT
// re-fetched from GitHub — that repo has since moved on to different
// contributor presets entirely; the router's installed copy is the only
// authoritative source). <HOSTLIST>/<HOSTLIST_NOAUTO> get replaced with a
// literal --hostlist=<per-pin file> for just this one block, independent
// of whatever the global hostlist/autohostlist is doing elsewhere.
// v1_by_Routerich deliberately excluded — too large/complex (14 numbered
// sub-strategies with hardcoded google.com-specific hostlist references)
// to safely templatize by hand.
var PIN_TEMPLATES = {
	default:
		'--filter-tcp=80\n--filter-l7=http <HOSTLIST>\n--payload=http_req\n--lua-desync=fake:blob=fake_default_http:tcp_md5\n--lua-desync=multisplit:pos=method+2\n\n' +
		'--new\n--filter-tcp=443\n--filter-l7=tls <HOSTLIST>\n--payload=tls_client_hello\n--lua-desync=fake:blob=fake_default_tls:tcp_md5:tcp_seq=-10000\n--lua-desync=multidisorder:pos=1,midsld\n\n' +
		'--new\n--filter-udp=443\n--filter-l7=quic <HOSTLIST_NOAUTO>\n--payload=quic_initial\n--lua-desync=fake:blob=fake_default_quic:repeats=6',

	v1_by_Schiz23:
		'--filter-tcp=80\n--filter-l7=http <HOSTLIST>\n--payload=http_req\n--lua-desync=fake:blob=fake_default_http:tcp_md5\n--lua-desync=multisplit:pos=method+2\n\n' +
		'--new\n--filter-tcp=443\n--filter-l7=tls <HOSTLIST>\n--lua-desync=fake:blob=fake_default_tls:ip_ttl=1:ip6_ttl=1:tls_mod=rnd,rndsni,padencap\n--lua-desync=multidisorder:payload=tls_client_hello:pos=3\n\n' +
		'--new\n--filter-udp=443\n--filter-l7=quic <HOSTLIST_NOAUTO>\n--lua-desync=fake:blob=fake_default_quic:repeats=11:payload=all:out_range=-d10',

	v2_by_Schiz23:
		'--filter-tcp=80\n--filter-l7=http <HOSTLIST>\n--payload=http_req\n--lua-desync=fake:blob=fake_default_http:tcp_md5\n--lua-desync=multisplit:pos=method+2\n\n' +
		'--new\n--filter-tcp=443\n--filter-l7=tls <HOSTLIST>\n--payload=tls_client_hello\n--lua-desync=multidisorder:payload=tls_client_hello:pos=100,midsld,sniext+1,endhost-2,-10\n--lua-desync=send:sni=.microsoft\n\n' +
		'--new\n--filter-udp=443\n--filter-l7=quic <HOSTLIST_NOAUTO>\n--payload=quic_initial\n--lua-desync=fake:blob=fake_default_quic:repeats=11',

	v1_by_AnonymTsk:
		'--blob=blob_tls_clienthello_www_google_com:@/opt/zapret2/files/fake/tls_clienthello_www_google_com.bin\n--blob=blob_quic_initial_www_google_com:@/opt/zapret2/files/fake/quic_initial_www_google_com.bin\n\n' +
		'--filter-tcp=443,80\n--filter-l7=http,tls <HOSTLIST>\n--payload=tls_client_hello\n--lua-desync=fake:blob=fake_default_tls:tls_mod=rnd,dupsid,sni=www.google.com:tcp_ts=-1000\n--lua-desync=multidisorder:pos=1,midsld,sniext+1,endhost-2,-10:seqovl=1:seqovl_pattern=blob_tls_clienthello_www_google_com:tcp_ts_up\n--payload=http_req\n--lua-desync=http_methodeol:badsum\n\n' +
		'--new\n--filter-udp=443\n--filter-l7=quic <HOSTLIST_NOAUTO>\n--payload=quic_initial\n--lua-desync=fake:blob=blob_quic_initial_www_google_com:repeats=11'
};

var PRESET_CHOICES = [
	{ key: 'default', title: 'По умолчанию' },
	{ key: 'v1_by_Schiz23', title: 'Schiz23 v1' },
	{ key: 'v2_by_Schiz23', title: 'Schiz23 v2' },
	{ key: 'v1_by_AnonymTsk', title: 'AnonymTsk v1 (Discord/Telegram/UDP)' }
];

// A service is rarely just one domain — video/CDN/API traffic for it usually
// lives on completely separate domains with their own DNS resolution (e.g.
// YouTube's player pulls video from googlevideo.com, not youtube.com). A pin
// that only covers the "main" domain leaves those uncovered — site loads,
// content doesn't. These are convenience starting points, not guaranteed
// exhaustive — add more domains by hand if something's still broken.
var FAMILY_PRESETS = {
	youtube: {
		title: 'YouTube',
		domains: [ 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
			'googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtubei.googleapis.com' ]
	},
	discord: {
		title: 'Discord',
		domains: [ 'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net',
			'media.discordapp.net', 'cdn.discordapp.com', 'gateway.discord.gg' ]
	},
	instagram: {
		title: 'Instagram',
		domains: [ 'instagram.com', 'www.instagram.com', 'cdninstagram.com', 'fbcdn.net' ]
	},
	twitter: {
		title: 'Twitter / X',
		domains: [ 'twitter.com', 'x.com', 'twimg.com', 't.co' ]
	}
};

function safeName(domain) {
	return domain.replace(/[^a-zA-Z0-9.\-]/g, '_');
}

function fillHostlist(template, pinFile) {
	return template
		.replace(/<HOSTLIST_NOAUTO>/g, '--hostlist=' + pinFile)
		.replace(/<HOSTLIST>/g, '--hostlist=' + pinFile);
}

function parseDomains(raw) {
	var seen = {};
	var out = [];
	(raw || '').split(/[\s,]+/).forEach(function (d) {
		d = d.trim().replace(/[^a-zA-Z0-9.\-]/g, '');
		if (d && !seen[d]) { seen[d] = true; out.push(d); }
	});
	return out;
}

// pins.json historically stored one domain per pin as a plain `domain`
// string. Normalize old entries to the current `{ id, domains: [...] }`
// shape on load so existing installs keep working without a migration step.
function normalizePin(pin) {
	if (Array.isArray(pin.domains) && pin.domains.length) {
		return { id: pin.id || safeName(pin.domains[0]), domains: pin.domains, preset: pin.preset, dns: pin.dns || '' };
	}
	return { id: safeName(pin.domain), domains: [ pin.domain ], preset: pin.preset, dns: pin.dns || '' };
}

return view.extend({
	pins: [],

	load: function () {
		return Promise.all([
			fs.read(PINS_FILE).catch(function () { return '[]'; }),
			uci.load('zapret2')
		]);
	},

	render: function (data) {
		try {
			var raw = JSON.parse(data[0] || '[]');
			this.pins = raw.map(normalizePin);
		} catch (e) { this.pins = []; }

		var domainInput = E('textarea', {
			'id': 'zr-pin-domain', 'rows': 3, 'style': 'flex:1;min-width:220px;font-family:monospace;',
			'placeholder': 'один домен на строку (или через запятую):\nyoutube.com\ngooglevideo.com\nytimg.com'
		});
		var presetSelect = E('select', { 'id': 'zr-pin-preset', 'style': 'width:220px;' },
			PRESET_CHOICES.map(function (p) { return E('option', { value: p.key }, p.title); })
		);
		var dnsInput = E('input', { 'type': 'text', 'id': 'zr-pin-dns', 'placeholder': 'необязательно: 8.8.8.8', 'style': 'width:160px;' });

		var addBtn = E('button', { 'class': 'cbi-button cbi-button-apply', 'click': ui.createHandlerFn(this, 'handleAdd') }, 'Закрепить');

		var familyButtons = E('div', { 'style': 'display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;' },
			Object.keys(FAMILY_PRESETS).map(function (key) {
				var fam = FAMILY_PRESETS[key];
				return E('button', {
					'class': 'cbi-button',
					'type': 'button',
					'click': function () { document.getElementById('zr-pin-domain').value = fam.domains.join('\n'); }
				}, 'Набор: ' + fam.title);
			})
		);

		var listBox = E('div', { 'id': 'zr-pin-list', 'style': 'margin:14px 0;' }, this.renderPinNodes());
		this.listBox = listBox;

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Закреплённые'),
			E('p', { 'class': 'cbi-value-description' },
				'Домены здесь всегда используют свою собственную стратегию (и, опционально, свой DNS-сервер) — независимо от того, что выставлено ' +
				'на Дашборде/Стратегиях. Изменение общих настроек эти домены не затронет.'),
			E('p', { 'class': 'cbi-value-description' },
				'Один пункт может держать сразу несколько доменов с общей стратегией и DNS — это важно, потому что у сервиса обычно есть отдельные домены ' +
				'для самого контента (видео/CDN/API), не только для главного сайта. Если закрепить только "youtube.com", сайт откроется, а видео — нет, ' +
				'потому что оно грузится с googlevideo.com, который остался на старых настройках.'),

			familyButtons,
			E('div', { 'style': 'display:flex;gap:8px;margin:14px 0;flex-wrap:wrap;align-items:flex-start;' }, [ domainInput, presetSelect, dnsInput, addBtn ]),

			listBox
		]);
	},

	renderPinNodes: function () {
		if (!this.pins.length) {
			return [ E('p', { 'class': 'cbi-value-description' }, 'Пока ничего не закреплено.') ];
		}
		return this.pins.map(L.bind(function (pin) {
			var presetTitle = (PRESET_CHOICES.filter(function (p) { return p.key === pin.preset; })[0] || {}).title || pin.preset;
			return E('div', { 'style': 'display:flex;align-items:center;gap:14px;padding:8px 0;border-bottom:1px solid #3335;' }, [
				E('div', { 'style': 'flex:1;' }, [
					E('div', { 'style': 'font-family:monospace;font-weight:bold;' }, pin.domains.join(', ')),
					E('div', { 'class': 'cbi-value-description' }, 'Стратегия: ' + presetTitle + (pin.dns ? (' · DNS: ' + pin.dns) : ''))
				]),
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': ui.createHandlerFn(this, 'handleRemove', pin.id) }, 'Открепить')
			]);
		}, this));
	},

	refreshList: function () {
		this.listBox.innerHTML = '';
		this.renderPinNodes().forEach(L.bind(function (node) { this.listBox.appendChild(node); }, this));
	},

	savePins: function () {
		return fs.write(PINS_FILE, JSON.stringify(this.pins, null, 2));
	},

	currentStrategyKey: function () {
		var opt = uci.get('zapret2', 'config', 'NFQWS2_OPT') || '';
		var m = /--comment=Strategy__(\S+)/.exec(opt);
		return (m && PIN_TEMPLATES[m[1]]) ? m[1] : 'default';
	},

	// Rebuild NFQWS2_OPT from scratch: clean global preset (whatever is
	// currently active) + one --new block per pin, each with a literal
	// --hostlist pointing at that pin's own file (which now may list several
	// domains, one per line). The actual "reset then append" happens entirely
	// inside rebuild-opt.sh via plain `uci` CLI commands — relying on LuCI's
	// client-side uci.js to read back a value a separate shell command had
	// just written turned out to silently not pick up the fresh value in
	// practice (same class of issue as the DNS section's uci.save() quirk).
	// Safe to call repeatedly — always starts from a freshly regenerated
	// clean base, never accumulates duplicates.
	rebuildOpt: function () {
		var presetKey = this.currentStrategyKey();
		var extra = this.pins.map(function (pin) {
			var tmpl = PIN_TEMPLATES[pin.preset] || PIN_TEMPLATES.default;
			var pinFile = PIN_HOSTS_DIR + '/' + pin.id + '.txt';
			return '--new\n' + fillHostlist(tmpl, pinFile);
		}).join('\n\n');

		return fs.write('/opt/zapretremix/pin-blocks.txt', extra)
			.then(function () { return fs.exec('/opt/zapretremix/rebuild-opt.sh', [ presetKey ]); })
			.then(L.bind(function () { return fs.exec(env_tools.syncCfgPath, []); }, this))
			.then(L.bind(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); }, this));
	},

	handleAdd: function () {
		var domains = parseDomains(document.getElementById('zr-pin-domain').value);
		var preset = document.getElementById('zr-pin-preset').value;
		var dns = document.getElementById('zr-pin-dns').value.trim();

		if (!domains.length) {
			ui.addNotification(null, E('p', {}, 'Введи хотя бы один корректный домен.'), 'error');
			return;
		}
		var id = safeName(domains[0]);
		if (this.pins.some(function (p) { return p.id === id; })) {
			ui.addNotification(null, E('p', {}, 'Пункт с таким первым доменом уже закреплён.'), 'error');
			return;
		}

		var pin = { id: id, domains: domains, preset: preset, dns: dns };
		this.pins.push(pin);
		var pinFile = PIN_HOSTS_DIR + '/' + id + '.txt';

		fs.exec('/bin/busybox', [ 'mkdir', '-p', PIN_HOSTS_DIR ])
			.then(function () { return fs.write(pinFile, domains.join('\n') + '\n'); })
			.then(L.bind(this.savePins, this))
			.then(L.bind(function () {
				if (dns) return this.applyPinDns(domains, dns);
			}, this))
			.then(L.bind(this.rebuildOpt, this))
			.then(L.bind(function () {
				this.refreshList();
				ui.addNotification(null, E('p', {}, domains.join(', ') + ' закреплены.'), 'info');
			}, this))
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	handleRemove: function (id) {
		var removed = this.pins.filter(function (p) { return p.id === id; })[0];
		this.pins = this.pins.filter(function (p) { return p.id !== id; });
		var pinFile = PIN_HOSTS_DIR + '/' + id + '.txt';

		this.savePins()
			.then(function () { return fs.exec('/bin/busybox', [ 'rm', '-f', pinFile ]); })
			.then(L.bind(function () {
				if (removed && removed.dns) return this.removePinDns(removed.domains, removed.dns);
			}, this))
			.then(L.bind(this.rebuildOpt, this))
			.then(L.bind(function () {
				this.refreshList();
				ui.addNotification(null, E('p', {}, (removed ? removed.domains.join(', ') : id) + ' откреплены.'), 'info');
			}, this))
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	// Per-pin DNS override via dnsmasq's domain-scoped server= entries
	// (dhcp.@dnsmasq[0].server, format "/domain/1.2.3.4") — independent of
	// whatever DNS mode is active on the Dashboard for everything else. One
	// entry per domain in the group, all pointing at the same server.
	applyPinDns: function (domains, dnsServer) {
		return uci.load('dhcp').then(function () {
			var list = uci.get('dhcp', '@dnsmasq[0]', 'server') || [];
			if (!Array.isArray(list)) list = [ list ];
			domains.forEach(function (domain) {
				var entry = '/' + domain + '/' + dnsServer;
				if (list.indexOf(entry) === -1) list.push(entry);
			});
			uci.set('dhcp', '@dnsmasq[0]', 'server', list);
			return uci.save().catch(function () {});
		}).then(function () {
			return fs.exec('/etc/init.d/dnsmasq', [ 'restart' ]);
		});
	},

	removePinDns: function (domains) {
		return uci.load('dhcp').then(function () {
			var list = uci.get('dhcp', '@dnsmasq[0]', 'server') || [];
			if (!Array.isArray(list)) list = [ list ];
			domains.forEach(function (domain) {
				list = list.filter(function (e) { return e.indexOf('/' + domain + '/') !== 0; });
			});
			uci.set('dhcp', '@dnsmasq[0]', 'server', list);
			return uci.save().catch(function () {});
		}).then(function () {
			return fs.exec('/etc/init.d/dnsmasq', [ 'restart' ]);
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
