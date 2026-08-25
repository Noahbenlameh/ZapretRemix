'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require uci';
'require view.zapret2.env as env_tools';
'require view.zapretremix.shared as shared';

// Backup/restore for everything ZapretRemix manages, bundled into one JSON
// file — a straight round-trip snapshot, not a cross-router migration tool:
// NFQWS2_OPT/ports/depth are restored byte-for-byte as they were on the
// source router, so a different def-cfg.sh version or router model can end
// up with stale/incompatible values. Safe default use case is "back up
// before experimenting, restore if it goes wrong" on the SAME router.
var SCHEMA_VERSION = 1;

var UCI_FIELDS = [
	'MODE_FILTER', 'NFQWS2_OPT', 'NFQWS2_PORTS_TCP', 'NFQWS2_PORTS_UDP',
	'NFQWS2_TCP_PKT_OUT', 'NFQWS2_TCP_PKT_IN', 'NFQWS2_UDP_PKT_OUT', 'NFQWS2_UDP_PKT_IN',
	'DAEMON_LOG_ENABLE'
];

var PINS_FILE = '/opt/zapretremix/pins.json';
var PROFILES_FILE = '/opt/zapretremix/proxy-profiles.json';
var DNS_POOL_FILE = '/opt/zapretremix/dns-pool.txt';
var PIN_HOSTS_DIR = '/opt/zapretremix/pin-hosts';

return view.extend({
	load: function () {
		return Promise.all([
			uci.load('zapret2'),
			uci.load('network'),
			fs.read(PINS_FILE).catch(function () { return '[]'; }),
			fs.read(PROFILES_FILE).catch(function () { return '[]'; }),
			fs.read(DNS_POOL_FILE).catch(function () { return ''; }),
			fs.read(env_tools.hostsUserFN).catch(function () { return ''; }),
			fs.read(env_tools.hostsUserExcludeFN).catch(function () { return ''; })
		]);
	},

	render: function (data) {
		this.snapshot = {
			pins: data[2],
			profiles: data[3],
			dnsPool: data[4],
			hosts: data[5],
			exclude: data[6]
		};

		var exportText = E('textarea', {
			'id': 'zr-export-text',
			'readonly': true,
			'rows': 8,
			'style': 'width:100%;font-family:monospace;font-size:12px;margin-top:8px;',
			'placeholder': 'Нажми «Сформировать и скачать» — здесь появится содержимое резервной копии.'
		}, '');

		var importText = E('textarea', {
			'id': 'zr-import-text',
			'rows': 8,
			'style': 'width:100%;font-family:monospace;font-size:12px;margin-top:8px;',
			'placeholder': 'Вставь сюда содержимое файла резервной копии, или выбери файл ниже.'
		}, '');

		var fileInput = E('input', {
			'type': 'file',
			'accept': 'application/json,.json',
			'change': ui.createHandlerFn(this, 'handleFilePick')
		});

		var container = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Экспорт / Импорт'),

			E('p', { 'class': 'cbi-value-description' },
				'Резервная копия всего, чем управляет ZapretRemix: режим фильтрации, глубина пакетов, ' +
				'сырая стратегия (NFQWS2_OPT), DNS-режим Дашборда, Закреплённые (с их DNS), Прокси по портам, ' +
				'Ресурсы и пул DNS из Рекомендаций. Это снимок конкретного роутера — восстанавливать ' +
				'лучше на том же роутере (или на роутере с той же версией zapret2), не как универсальный ' +
				'способ переноса между разными моделями.'),

			E('h3', {}, 'Экспорт'),
			E('button', {
				'class': 'cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, 'handleExport')
			}, 'Сформировать и скачать'),
			exportText,

			E('h3', { 'style': 'margin-top:28px;' }, 'Импорт'),
			E('p', { 'class': 'cbi-value-description' },
				'Заменяет текущие настройки ZapretRemix содержимым файла. Само применение (рестарт демона, ' +
				'dnsmasq) произойдёт сразу после подтверждения — на случай проблем есть штатный откат LuCI, ' +
				'как и везде в приложении, но полноценного отдельного тестового периода здесь нет.'),
			fileInput,
			importText,
			E('div', { 'style': 'margin-top:8px;' }, [
				E('button', {
					'class': 'cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(this, 'handleImport')
				}, 'Восстановить из файла')
			])
		]);

		return container;
	},

	buildExportBundle: function () {
		var zapret2 = {};
		UCI_FIELDS.forEach(function (f) {
			zapret2[f] = uci.get('zapret2', 'config', f) || '';
		});

		return {
			schema: SCHEMA_VERSION,
			exportedAt: new Date().toISOString(),
			zapret2: zapret2,
			wanDns: {
				peerdns: uci.get('network', 'wan', 'peerdns') || '',
				dns: uci.get('network', 'wan', 'dns') || ''
			},
			pins: JSON.parse(this.snapshot.pins || '[]'),
			proxyProfiles: JSON.parse(this.snapshot.profiles || '[]'),
			dnsPool: this.snapshot.dnsPool || '',
			resources: {
				hosts: this.snapshot.hosts || '',
				exclude: this.snapshot.exclude || ''
			}
		};
	},

	handleExport: function () {
		var bundle;
		try {
			bundle = this.buildExportBundle();
		} catch (e) {
			ui.addNotification(null, E('p', {}, 'Не удалось собрать резервную копию: ' + e), 'error');
			return;
		}

		var text = JSON.stringify(bundle, null, 2);
		document.getElementById('zr-export-text').value = text;

		var blob = new Blob([ text ], { type: 'application/json' });
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');
		a.href = url;
		a.download = 'zapretremix-backup-' + bundle.exportedAt.slice(0, 10) + '.json';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

		ui.addNotification(null, E('p', {},
			bundle.pins.length + ' закреплений, ' + bundle.proxyProfiles.length + ' прокси-профилей — выгружено.'), 'info');
	},

	handleFilePick: function (ev) {
		var file = ev.target.files && ev.target.files[0];
		if (!file) return;
		var reader = new FileReader();
		reader.onload = function () {
			document.getElementById('zr-import-text').value = reader.result;
		};
		reader.readAsText(file);
	},

	handleImport: function () {
		var raw = document.getElementById('zr-import-text').value.trim();
		if (!raw) {
			ui.addNotification(null, E('p', {}, 'Сначала вставь содержимое резервной копии или выбери файл.'), 'warning');
			return;
		}

		var bundle;
		try {
			bundle = JSON.parse(raw);
		} catch (e) {
			ui.addNotification(null, E('p', {}, 'Не удалось разобрать JSON: ' + e), 'error');
			return;
		}

		if (!bundle || typeof bundle !== 'object' || !bundle.zapret2) {
			ui.addNotification(null, E('p', {}, 'Файл не похож на резервную копию ZapretRemix.'), 'error');
			return;
		}

		if (!confirm('Заменить текущие настройки ZapretRemix содержимым файла от ' +
				(bundle.exportedAt || 'неизвестной даты') + '?')) {
			return;
		}

		this.doImport(bundle).then(function () {
			ui.addNotification(null, E('p', {}, 'Восстановлено и применено.'), 'info');
		}).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Ошибка восстановления: ' + err), 'error');
		});
	},

	doImport: function (bundle) {
		var pins = Array.isArray(bundle.pins) ? bundle.pins.map(shared.normalizePin) : [];
		var profiles = Array.isArray(bundle.proxyProfiles) ? bundle.proxyProfiles : [];

		UCI_FIELDS.forEach(function (f) {
			if (bundle.zapret2[f] !== undefined) {
				uci.set('zapret2', 'config', f, bundle.zapret2[f]);
			}
		});
		if (bundle.wanDns) {
			uci.set('network', 'wan', 'peerdns', bundle.wanDns.peerdns || null);
			uci.set('network', 'wan', 'dns', bundle.wanDns.dns || null);
		}

		return uci.save()
			.then(function () { return fs.exec('/bin/busybox', [ 'mkdir', '-p', PIN_HOSTS_DIR ]); })
			.then(function () {
				return Promise.all(pins.map(function (pin) {
					return fs.write(PIN_HOSTS_DIR + '/' + pin.id + '.txt', pin.domains.join('\n') + '\n');
				}));
			})
			.then(function () { return fs.write(PINS_FILE, JSON.stringify(pins, null, 2)); })
			.then(function () { return fs.write(PROFILES_FILE, JSON.stringify(profiles, null, 2)); })
			.then(function () { return fs.write(DNS_POOL_FILE, bundle.dnsPool || ''); })
			.then(function () {
				var r = bundle.resources || {};
				return Promise.all([
					fs.write(env_tools.hostsUserFN, r.hosts || ''),
					fs.write(env_tools.hostsUserExcludeFN, r.exclude || '')
				]);
			})
			.then(L.bind(this.restorePinDns, this, pins))
			.then(function () { return fs.exec(env_tools.syncCfgPath, []); })
			.then(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); })
			.then(function () { return fs.exec('/etc/init.d/dnsmasq', [ 'restart' ]); });
	},

	// Re-derives dhcp.@dnsmasq[0].server domain-scoped DNS entries from the
	// restored pins — same "/domain/ip" format as pins.js's applyPinDns, kept
	// separate here since import restores the whole pin list at once instead
	// of one pin at a time.
	restorePinDns: function (pins) {
		return uci.load('dhcp').then(function () {
			var list = uci.get('dhcp', '@dnsmasq[0]', 'server') || [];
			if (!Array.isArray(list)) list = [ list ];
			pins.forEach(function (pin) {
				if (!pin.dns) return;
				pin.domains.forEach(function (domain) {
					var entry = '/' + domain + '/' + pin.dns;
					if (list.indexOf(entry) === -1) list.push(entry);
				});
			});
			uci.set('dhcp', '@dnsmasq[0]', 'server', list);
			return uci.save().catch(function () {});
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
