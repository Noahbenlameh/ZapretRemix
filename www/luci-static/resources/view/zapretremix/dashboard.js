'use strict';
'require baseclass';
'require fs';
'require rpc';
'require ui';
'require uci';
'require view.zapret2.env as env_tools';

var PKT_PRESETS = {
	small:  { out: '20',     in: '10',     label: 'Первые пакеты (по умолчанию)' },
	medium: { out: '100',    in: '50',     label: 'Первые 100 пакетов' },
	large:  { out: '1000',   in: '500',    label: 'Первые 1000 пакетов' },
	always: { out: '100000', in: '100000', label: 'Всегда (весь трафик соединения)' }
};

var MODE_LABELS = {
	none:         'Выключено — обрабатывать весь трафик без разбора (максимальная нагрузка)',
	hostlist:     'Только выбранные сайты — по списку ресурсов',
	autohostlist: 'Умный автоматический режим — сам находит проблемные сайты'
};

var REVERT_SECONDS = 20;

return view.extend({
	revertTimer: null,
	prevValues: null,
	container: null,

	load: function () {
		return Promise.all([
			uci.load('zapret2'),
			fs.exec('/bin/busybox', [ 'ps' ]).catch(function () {
				return { code: -1, stdout: '' };
			})
		]);
	},

	getCurrentConfig: function () {
		return {
			mode:   uci.get('zapret2', 'config', 'MODE_FILTER') || 'hostlist',
			pktOut: uci.get('zapret2', 'config', 'NFQWS2_TCP_PKT_OUT') || '20',
			pktIn:  uci.get('zapret2', 'config', 'NFQWS2_TCP_PKT_IN') || '10',
			udpOut: uci.get('zapret2', 'config', 'NFQWS2_UDP_PKT_OUT') || '5',
			udpIn:  uci.get('zapret2', 'config', 'NFQWS2_UDP_PKT_IN') || '3'
		};
	},

	applyConfig: function (cfg) {
		uci.set('zapret2', 'config', 'MODE_FILTER', cfg.mode);
		uci.set('zapret2', 'config', 'NFQWS2_TCP_PKT_OUT', cfg.pktOut);
		uci.set('zapret2', 'config', 'NFQWS2_TCP_PKT_IN', cfg.pktIn);
		uci.set('zapret2', 'config', 'NFQWS2_UDP_PKT_OUT', cfg.udpOut);
		uci.set('zapret2', 'config', 'NFQWS2_UDP_PKT_IN', cfg.udpIn);
		return uci.save()
			.then(function () { return fs.exec(env_tools.syncCfgPath, []); })
			.then(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); });
	},

	isRunning: function (psOutput) {
		return (psOutput || '').indexOf('nfqws2') !== -1;
	},

	matchPreset: function (cfg) {
		for (var key in PKT_PRESETS) {
			if (PKT_PRESETS[key].out === cfg.pktOut && PKT_PRESETS[key].in === cfg.pktIn)
				return key;
		}
		return 'small';
	},

	render: function (data) {
		var psOutput = (data[1] && data[1].stdout) || '';
		var running = this.isRunning(psOutput);
		var cfg = this.getCurrentConfig();
		this.prevValues = cfg;

		var statusBadge = E('span', {
			'style': 'padding:3px 10px;border-radius:3px;color:#fff;font-weight:bold;' +
				(running ? 'background:#2ea256;' : 'background:#a33;')
		}, running ? 'РАБОТАЕТ' : 'ОСТАНОВЛЕН');

		var modeSelect = E('select', { 'id': 'zr-mode', 'style': 'width:100%;max-width:480px;' },
			Object.keys(MODE_LABELS).map(function (key) {
				var attrs = { value: key };
				if (key === cfg.mode) attrs.selected = 'selected';
				return E('option', attrs, MODE_LABELS[key]);
			})
		);

		var selectedPreset = this.matchPreset(cfg);
		var pktHidden = E('input', { type: 'hidden', id: 'zr-pkt-selected', value: selectedPreset });

		var pktButtons = E('div', { 'id': 'zr-pkt-buttons', 'style': 'display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;' },
			Object.keys(PKT_PRESETS).map(function (key) {
				var preset = PKT_PRESETS[key];
				var isActive = (key === selectedPreset);
				return E('button', {
					'class': 'cbi-button' + (isActive ? ' cbi-button-positive' : ''),
					'data-pkt-key': key,
					'click': ui.createHandlerFn(this, function (k, ev) {
						document.getElementById('zr-pkt-selected').value = k;
						var btns = document.querySelectorAll('#zr-pkt-buttons button');
						for (var i = 0; i < btns.length; i++) {
							btns[i].classList.remove('cbi-button-positive');
						}
						ev.target.classList.add('cbi-button-positive');
					}, key)
				}, preset.label);
			}, this)
		);

		var applyBtn = E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': ui.createHandlerFn(this, 'handleApplyClick')
		}, 'Применить');

		var startBtn = E('button', {
			'class': 'cbi-button cbi-button-positive',
			'click': ui.createHandlerFn(this, 'handleServiceAction', 'start')
		}, 'Старт');
		var stopBtn = E('button', {
			'class': 'cbi-button cbi-button-negative',
			'click': ui.createHandlerFn(this, 'handleServiceAction', 'stop')
		}, 'Стоп');
		var restartBtn = E('button', {
			'class': 'cbi-button',
			'click': ui.createHandlerFn(this, 'handleServiceAction', 'restart')
		}, 'Рестарт');

		var revertBox = E('div', {
			'id': 'zr-revert-box',
			'style': 'display:none;margin-top:14px;padding:12px 14px;border:1px solid #c90;background:#fff8e6;border-radius:4px;color:#333;'
		});

		var container = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Дашборд'),
			E('div', { 'style': 'margin-bottom:16px;' }, [ E('strong', {}, 'Статус демона: '), statusBadge ]),
			E('div', { 'style': 'display:flex;gap:8px;margin-bottom:24px;' }, [ startBtn, stopBtn, restartBtn ]),

			E('h3', {}, 'Режим фильтрации'),
			E('div', { 'style': 'margin-bottom:20px;' }, modeSelect),

			E('h3', {}, 'Глубина обработки пакетов'),
			E('p', { 'class': 'cbi-value-description' },
				'Сколько пакетов каждого нового соединения обрабатывать. Больше — надёжнее для длинных сессий, но выше нагрузка на роутер.'),
			pktButtons,
			pktHidden,

			E('div', { 'style': 'margin-top:20px;' }, applyBtn),
			revertBox
		]);

		this.container = container;
		return container;
	},

	handleServiceAction: function (action) {
		return fs.exec(env_tools.execPath, [ action ]).then(L.bind(function () {
			ui.addNotification(null, E('p', {}, 'Команда «' + action + '» выполнена.'), 'info');
			return this.load().then(L.bind(function (data) {
				var freshNode = this.render(data);
				this.container.parentNode.replaceChild(freshNode, this.container);
			}, this));
		}, this)).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
		});
	},

	handleApplyClick: function () {
		var mode = document.getElementById('zr-mode').value;
		var pktKey = document.getElementById('zr-pkt-selected').value;
		var preset = PKT_PRESETS[pktKey] || PKT_PRESETS.small;

		var oldCfg = this.prevValues;
		var newCfg = {
			mode:   mode,
			pktOut: preset.out,
			pktIn:  preset.in,
			udpOut: oldCfg.udpOut,
			udpIn:  oldCfg.udpIn
		};

		this.applyConfig(newCfg).then(L.bind(function () {
			this.prevValues = newCfg;
			this.startRevertCountdown(oldCfg);
		}, this)).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Не удалось применить настройки: ' + err), 'error');
		});
	},

	startRevertCountdown: function (oldCfg) {
		var box = document.getElementById('zr-revert-box');
		var self = this;
		var seconds = REVERT_SECONDS;

		if (this.revertTimer) {
			clearInterval(this.revertTimer);
			this.revertTimer = null;
		}

		function draw() {
			box.style.display = 'block';
			box.innerHTML = '';
			box.appendChild(E('p', {}, 'Настройки применены. Если что-то пошло не так — через ' + seconds +
				' сек. произойдёт автоматический откат к предыдущим значениям.'));
			var confirmBtn = E('button', {
				'class': 'cbi-button cbi-button-positive',
				'click': function () {
					clearInterval(self.revertTimer);
					self.revertTimer = null;
					box.style.display = 'none';
					ui.addNotification(null, E('p', {}, 'Изменения подтверждены и сохранены.'), 'info');
				}
			}, 'Подтвердить (оставить как есть)');
			box.appendChild(confirmBtn);
		}

		draw();
		this.revertTimer = setInterval(function () {
			seconds -= 1;
			if (seconds <= 0) {
				clearInterval(self.revertTimer);
				self.revertTimer = null;
				box.style.display = 'none';
				self.applyConfig(oldCfg).then(function () {
					self.prevValues = oldCfg;
					ui.addNotification(null, E('p', {}, 'Автоматически откачено к предыдущим настройкам.'), 'warning');
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
