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

function safeName(domain) {
	return domain.replace(/[^a-zA-Z0-9.\-]/g, '_');
}

function fillHostlist(template, pinFile) {
	return template
		.replace(/<HOSTLIST_NOAUTO>/g, '--hostlist=' + pinFile)
		.replace(/<HOSTLIST>/g, '--hostlist=' + pinFile);
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
		try { this.pins = JSON.parse(data[0] || '[]'); } catch (e) { this.pins = []; }

		var domainInput = E('input', { 'type': 'text', 'id': 'zr-pin-domain', 'placeholder': 'youtube.com', 'style': 'flex:1;' });
		var presetSelect = E('select', { 'id': 'zr-pin-preset', 'style': 'width:220px;' },
			PRESET_CHOICES.map(function (p) { return E('option', { value: p.key }, p.title); })
		);
		var dnsInput = E('input', { 'type': 'text', 'id': 'zr-pin-dns', 'placeholder': 'необязательно: 8.8.8.8', 'style': 'width:160px;' });

		var addBtn = E('button', { 'class': 'cbi-button cbi-button-apply', 'click': ui.createHandlerFn(this, 'handleAdd') }, 'Закрепить');

		var listBox = E('div', { 'id': 'zr-pin-list', 'style': 'margin:14px 0;' }, this.renderPinNodes());
		this.listBox = listBox;

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Закреплённые'),
			E('p', { 'class': 'cbi-value-description' },
				'Домены здесь всегда используют свою собственную стратегию (и, опционально, свой DNS-сервер) — независимо от того, что выставлено ' +
				'на Дашборде/Стратегиях. Изменение общих настроек эти домены не затронет.'),

			E('div', { 'style': 'display:flex;gap:8px;margin:14px 0;flex-wrap:wrap;' }, [ domainInput, presetSelect, dnsInput, addBtn ]),

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
					E('div', { 'style': 'font-family:monospace;font-weight:bold;' }, pin.domain),
					E('div', { 'class': 'cbi-value-description' }, 'Стратегия: ' + presetTitle + (pin.dns ? (' · DNS: ' + pin.dns) : ''))
				]),
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': ui.createHandlerFn(this, 'handleRemove', pin.domain) }, 'Открепить')
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
	// --hostlist pointing at that pin's own file. Called after any pin
	// add/remove so pins always reflect the current set correctly, and
	// safe to call repeatedly (never accumulates duplicate blocks, since
	// it always starts from a freshly regenerated clean base).
	rebuildOpt: function () {
		var presetKey = this.currentStrategyKey();
		var cmd = '. ' + env_tools.defCfgPath + '; set_cfg_nfqws_strat ' + presetKey + ' zapret2';

		return fs.exec('/bin/busybox', [ 'sh', '-c', cmd ])
			.then(L.bind(function () { return uci.load('zapret2'); }, this))
			.then(L.bind(function () {
				var cleanOpt = uci.get('zapret2', 'config', 'NFQWS2_OPT') || '';
				var finalOpt = cleanOpt;
				this.pins.forEach(function (pin) {
					var tmpl = PIN_TEMPLATES[pin.preset] || PIN_TEMPLATES.default;
					var pinFile = PIN_HOSTS_DIR + '/' + safeName(pin.domain) + '.txt';
					finalOpt += '\n\n--new\n' + fillHostlist(tmpl, pinFile);
				});
				uci.set('zapret2', 'config', 'NFQWS2_OPT', finalOpt);
				return uci.save().catch(function () {});
			}, this))
			.then(L.bind(function () { return fs.exec(env_tools.syncCfgPath, []); }, this))
			.then(L.bind(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); }, this));
	},

	handleAdd: function () {
		var domain = document.getElementById('zr-pin-domain').value.trim().replace(/[^a-zA-Z0-9.\-]/g, '');
		var preset = document.getElementById('zr-pin-preset').value;
		var dns = document.getElementById('zr-pin-dns').value.trim();

		if (!domain) {
			ui.addNotification(null, E('p', {}, 'Введи корректный домен.'), 'error');
			return;
		}
		if (this.pins.some(function (p) { return p.domain === domain; })) {
			ui.addNotification(null, E('p', {}, 'Этот домен уже закреплён.'), 'error');
			return;
		}

		this.pins.push({ domain: domain, preset: preset, dns: dns });
		var pinFile = PIN_HOSTS_DIR + '/' + safeName(domain) + '.txt';

		fs.exec('/bin/busybox', [ 'mkdir', '-p', PIN_HOSTS_DIR ])
			.then(function () { return fs.write(pinFile, domain + '\n'); })
			.then(L.bind(this.savePins, this))
			.then(L.bind(function () {
				if (dns) return this.applyPinDns(domain, dns);
			}, this))
			.then(L.bind(this.rebuildOpt, this))
			.then(L.bind(function () {
				this.refreshList();
				ui.addNotification(null, E('p', {}, domain + ' закреплён.'), 'info');
			}, this))
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	handleRemove: function (domain) {
		var removed = this.pins.filter(function (p) { return p.domain === domain; })[0];
		this.pins = this.pins.filter(function (p) { return p.domain !== domain; });
		var pinFile = PIN_HOSTS_DIR + '/' + safeName(domain) + '.txt';

		this.savePins()
			.then(function () { return fs.exec('/bin/busybox', [ 'rm', '-f', pinFile ]); })
			.then(L.bind(function () {
				if (removed && removed.dns) return this.removePinDns(domain);
			}, this))
			.then(L.bind(this.rebuildOpt, this))
			.then(L.bind(function () {
				this.refreshList();
				ui.addNotification(null, E('p', {}, domain + ' откреплён.'), 'info');
			}, this))
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	// Per-pin DNS override via dnsmasq's domain-scoped server= entries
	// (dhcp.@dnsmasq[0].server, format "/domain/1.2.3.4") — independent of
	// whatever DNS mode is active on the Dashboard for everything else.
	applyPinDns: function (domain, dnsServer) {
		return uci.load('dhcp').then(function () {
			var list = uci.get('dhcp', '@dnsmasq[0]', 'server') || [];
			if (!Array.isArray(list)) list = [ list ];
			var entry = '/' + domain + '/' + dnsServer;
			if (list.indexOf(entry) === -1) list.push(entry);
			uci.set('dhcp', '@dnsmasq[0]', 'server', list);
			return uci.save().catch(function () {});
		}).then(function () {
			return fs.exec('/etc/init.d/dnsmasq', [ 'restart' ]);
		});
	},

	removePinDns: function (domain) {
		return uci.load('dhcp').then(function () {
			var list = uci.get('dhcp', '@dnsmasq[0]', 'server') || [];
			if (!Array.isArray(list)) list = [ list ];
			list = list.filter(function (e) { return e.indexOf('/' + domain + '/') !== 0; });
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
