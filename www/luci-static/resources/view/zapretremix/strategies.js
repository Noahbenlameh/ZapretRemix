'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require uci';
'require view.zapret2.env as env_tools';

var PRESETS = [
	{ key: 'default', title: 'По умолчанию', desc: 'Общего назначения: подмена TLS ClientHello + разбивка пакетов для HTTP/HTTPS, базовая обработка QUIC.' },
	{ key: 'v1_by_Schiz23', title: 'Schiz23 v1', desc: 'Альтернативный набор трюков для TLS (случайные модификации, доп. TTL-игры) — пробовать, если "По умолчанию" не помогает.' },
	{ key: 'v2_by_Schiz23', title: 'Schiz23 v2', desc: 'Вторая версия того же автора, другой порядок разбивки TLS ClientHello.' },
	{ key: 'v1_by_AnonymTsk', title: 'AnonymTsk v1', desc: 'Более тяжёлая стратегия: отдельно обрабатывает Discord/Telegram(MTProto)/WireGuard/STUN по UDP, плюс fake+multidisorder для TLS/QUIC с привязкой к google.com.' },
	{ key: 'v1_by_Routerich', title: 'Routerich v1', desc: 'Самая сложная/тяжёлая — до 14 разных под-стратегий с автопереключением по числу неудач (circular). Для упорных блокировок, выше нагрузка на роутер.' }
];

var REVERT_SECONDS = 20;
var PINS_FILE = '/opt/zapretremix/pins.json';

// Kept in sync with pins.js's PIN_TEMPLATES — duplicated rather than shared
// via a common module, given only these two files need it. Needed here so
// that applying a strategy globally doesn't wipe out pinned per-domain
// blocks (set_cfg_nfqws_strat overwrites NFQWS2_OPT entirely with just the
// clean global preset — pins have to be re-appended every time afterward).
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

return view.extend({
	prevRaw: null,
	revertTimer: null,

	load: function () {
		return uci.load('zapret2');
	},

	getRawFields: function () {
		return {
			mode:   uci.get('zapret2', 'config', 'MODE_FILTER') || 'hostlist',
			opt:    uci.get('zapret2', 'config', 'NFQWS2_OPT') || '',
			tcp:    uci.get('zapret2', 'config', 'NFQWS2_PORTS_TCP') || '80,443',
			udp:    uci.get('zapret2', 'config', 'NFQWS2_PORTS_UDP') || '443'
		};
	},

	currentStrategyName: function (opt) {
		var m = /--comment=Strategy__(\S+)/.exec(opt || '');
		return m ? m[1] : '(нестандартная/ручная)';
	},

	setRawFields: function (fields) {
		uci.set('zapret2', 'config', 'MODE_FILTER', fields.mode);
		uci.set('zapret2', 'config', 'NFQWS2_OPT', fields.opt);
		uci.set('zapret2', 'config', 'NFQWS2_PORTS_TCP', fields.tcp);
		uci.set('zapret2', 'config', 'NFQWS2_PORTS_UDP', fields.udp);
		return uci.save()
			.then(function () { return fs.exec(env_tools.syncCfgPath, []); })
			.then(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); });
	},

	// Writes /opt/zapretremix/pin-blocks.txt for rebuild-opt.sh to append —
	// needed because that script (called by handleApplyPreset) resets
	// NFQWS2_OPT entirely to the clean global preset, which would otherwise
	// silently drop pins the moment someone changes the global strategy.
	// The actual "read current OPT + append + commit" happens inside the
	// shell script via plain `uci` CLI — doing it via LuCI's client-side
	// uci.js (reading back a value a separate shell command just wrote)
	// turned out to silently not pick up the fresh value in practice.
	writePinBlocks: function () {
		return fs.read(PINS_FILE).catch(function () { return '[]'; }).then(function (text) {
			var pins;
			try { pins = JSON.parse(text); } catch (e) { pins = []; }
			var extra = pins.map(function (pin) {
				var tmpl = PIN_TEMPLATES[pin.preset] || PIN_TEMPLATES.default;
				// pins.json entries are { id, domains: [...] } as of the
				// multi-domain pin change; fall back to the older single-
				// `domain` string shape for pins created before that.
				var firstDomain = (Array.isArray(pin.domains) && pin.domains.length) ? pin.domains[0] : pin.domain;
				var id = pin.id || firstDomain.replace(/[^a-zA-Z0-9.\-]/g, '_');
				var pinFile = '/opt/zapretremix/pin-hosts/' + id + '.txt';
				return '--new\n' + tmpl
					.replace(/<HOSTLIST_NOAUTO>/g, '--hostlist=' + pinFile)
					.replace(/<HOSTLIST>/g, '--hostlist=' + pinFile);
			}).join('\n\n');
			return fs.write('/opt/zapretremix/pin-blocks.txt', extra);
		});
	},

	render: function () {
		var raw = this.getRawFields();
		this.prevRaw = raw;
		var curName = this.currentStrategyName(raw.opt);

		var currentLine = E('p', {}, [
			E('strong', {}, 'Текущая стратегия: '),
			E('span', { 'id': 'zr-cur-strategy' }, curName)
		]);

		var presetRows = E('div', {}, PRESETS.map(L.bind(function (p) {
			return E('div', { 'style': 'display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #3335;' }, [
				E('div', { 'style': 'flex:1;' }, [
					E('div', { 'style': 'font-weight:bold;' }, p.title),
					E('div', { 'class': 'cbi-value-description' }, p.desc)
				]),
				E('button', {
					'class': 'cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, 'handleApplyPreset', p.key)
				}, 'Применить')
			]);
		}, this)));

		var advToggle = E('button', { 'class': 'cbi-button', 'click': function () {
			var box = document.getElementById('zr-adv-box');
			box.style.display = (box.style.display === 'none') ? 'block' : 'none';
		} }, 'Показать/скрыть расширенные настройки');

		var optArea = E('textarea', {
			'id': 'zr-opt-raw',
			'style': 'width:100%;height:220px;font-family:monospace;font-size:12px;',
			'spellcheck': 'false'
		}, raw.opt);

		var tcpInput = E('input', { 'type': 'text', 'id': 'zr-tcp-ports', 'value': raw.tcp, 'style': 'width:140px;' });
		var udpInput = E('input', { 'type': 'text', 'id': 'zr-udp-ports', 'value': raw.udp, 'style': 'width:140px;' });

		var advBox = E('div', { 'id': 'zr-adv-box', 'style': 'display:none;margin-top:14px;padding:14px;border:1px solid #3335;border-radius:4px;' }, [
			E('p', { 'class': 'cbi-value-description' }, 'Прямое редактирование NFQWS2_OPT. Только для тех, кто понимает синтаксис zapret2/nfqws2.'),
			E('div', { 'style': 'display:flex;gap:20px;margin-bottom:10px;' }, [
				E('div', {}, [ E('label', {}, 'TCP порты: '), tcpInput ]),
				E('div', {}, [ E('label', {}, 'UDP порты: '), udpInput ])
			]),
			optArea,
			E('div', { 'style': 'margin-top:10px;' }, E('button', {
				'class': 'cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, 'handleApplyCustom')
			}, 'Применить свои настройки'))
		]);

		var revertBox = E('div', {
			'id': 'zr-revert-box',
			'style': 'display:none;margin-top:14px;padding:12px 14px;border:1px solid #c90;background:#fff8e6;border-radius:4px;color:#333;'
		});

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Стратегии'),
			currentLine,
			E('h3', {}, 'Готовые пресеты'),
			presetRows,
			E('div', { 'style': 'margin-top:16px;' }, advToggle),
			advBox,
			revertBox
		]);
	},

	handleApplyPreset: function (key) {
		var oldRaw = this.prevRaw;
		this.writePinBlocks()
			.then(function () { return fs.exec('/opt/zapretremix/rebuild-opt.sh', [ key ]); })
			.then(L.bind(function () { return fs.exec(env_tools.syncCfgPath, []); }, this))
			.then(L.bind(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); }, this))
			.then(L.bind(function () {
				return uci.load('zapret2').then(L.bind(function () {
					var newRaw = this.getRawFields();
					this.prevRaw = newRaw;
					var badge = document.getElementById('zr-cur-strategy');
					if (badge) badge.textContent = this.currentStrategyName(newRaw.opt);
					ui.addNotification(null, E('p', {}, 'Стратегия «' + key + '» применена.'), 'info');
					this.startRevertCountdown(oldRaw);
				}, this));
			}, this))
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	handleApplyCustom: function () {
		// Deliberately does NOT re-append pins here — this path applies
		// whatever raw text the user typed verbatim (which may already
		// include pin blocks from a prior rebuild); auto-appending again
		// here risks duplicating them. Custom mode is power-user territory,
		// managing pin blocks manually if visible in the textarea is on them.
		var oldRaw = this.prevRaw;
		var newRaw = {
			mode: oldRaw.mode,
			opt:  document.getElementById('zr-opt-raw').value,
			tcp:  document.getElementById('zr-tcp-ports').value,
			udp:  document.getElementById('zr-udp-ports').value
		};
		this.setRawFields(newRaw).then(L.bind(function () {
			this.prevRaw = newRaw;
			var badge = document.getElementById('zr-cur-strategy');
			if (badge) badge.textContent = this.currentStrategyName(newRaw.opt);
			ui.addNotification(null, E('p', {}, 'Настройки применены.'), 'info');
			this.startRevertCountdown(oldRaw);
		}, this)).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
		});
	},

	startRevertCountdown: function (oldRaw) {
		var box = document.getElementById('zr-revert-box');
		var self = this;
		var seconds = REVERT_SECONDS;

		if (this.revertTimer) { clearInterval(this.revertTimer); this.revertTimer = null; }

		function draw() {
			box.style.display = 'block';
			box.innerHTML = '';
			box.appendChild(E('p', {}, 'Стратегия применена. Если что-то сломалось — через ' + seconds +
				' сек. произойдёт автоматический откат к предыдущей.'));
			box.appendChild(E('button', {
				'class': 'cbi-button cbi-button-positive',
				'click': function () {
					clearInterval(self.revertTimer);
					self.revertTimer = null;
					box.style.display = 'none';
					ui.addNotification(null, E('p', {}, 'Изменения подтверждены.'), 'info');
				}
			}, 'Подтвердить (оставить как есть)'));
		}

		draw();
		this.revertTimer = setInterval(function () {
			seconds -= 1;
			if (seconds <= 0) {
				clearInterval(self.revertTimer);
				self.revertTimer = null;
				box.style.display = 'none';
				self.setRawFields(oldRaw).then(function () {
					self.prevRaw = oldRaw;
					var badge = document.getElementById('zr-cur-strategy');
					if (badge) badge.textContent = self.currentStrategyName(oldRaw.opt);
					ui.addNotification(null, E('p', {}, 'Автоматически откачено к предыдущей стратегии.'), 'warning');
				});
				return;
			}
			draw();
		}, 1000);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
