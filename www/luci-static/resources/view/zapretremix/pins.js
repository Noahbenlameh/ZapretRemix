'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require uci';
'require view.zapret2.env as env_tools';
'require view.zapretremix.shared as shared';

var PINS_FILE = '/opt/zapretremix/pins.json';
var PIN_HOSTS_DIR = '/opt/zapretremix/pin-hosts';

// Preset templates, the strategy dropdown list, domain-family sets, and the
// domain/pin helper functions all live in shared.js now (recommend.js and
// strategies.js use the same copy) — see that file for details/comments.
var PIN_TEMPLATES = shared.PIN_TEMPLATES;
var PRESET_CHOICES = shared.PRESET_CHOICES;
var FAMILY_PRESETS = shared.FAMILY_PRESETS;
var safeName = shared.safeName;
var fillHostlist = shared.fillHostlist;
var parseDomains = shared.parseDomains;
var normalizePin = shared.normalizePin;

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
