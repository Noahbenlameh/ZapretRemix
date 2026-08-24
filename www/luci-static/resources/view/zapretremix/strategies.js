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
		var cmd = '. ' + env_tools.defCfgPath + '; set_cfg_nfqws_strat ' + key + ' zapret2';
		fs.exec('/bin/busybox', [ 'sh', '-c', cmd ])
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
