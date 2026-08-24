'use strict';
'require baseclass';
'require view';
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
var PUBLIC_DNS = '8.8.8.8 1.1.1.1';

return view.extend({
	revertTimer: null,
	dnsRevertTimer: null,
	prevValues: null,
	prevDns: null,
	container: null,

	load: function () {
		return Promise.all([
			uci.load('zapret2'),
			uci.load('network'),
			fs.exec('/bin/busybox', [ 'ps' ]).catch(function () {
				return { code: -1, stdout: '' };
			}),
			this.getIspDns()
		]);
	},

	// DNS server(s) actually handed out by the ISP over DHCP — fetched fresh
	// regardless of what network.wan.dns/peerdns currently say, so this stays
	// accurate even while a different DNS mode is active.
	getIspDns: function () {
		return fs.exec('/bin/busybox', [ 'sh', '-c', 'ubus call network.interface.wan status' ])
			.then(function (res) {
				try {
					var data = JSON.parse((res && res.stdout) || '{}');
					return Array.isArray(data['dns-server'])
						? data['dns-server'].filter(function (ip) { return ip.indexOf(':') === -1; })
						: [];
				} catch (e) {
					return [];
				}
			})
			.catch(function () { return []; });
	},

	getDnsConfig: function () {
		var peerdns = uci.get('network', 'wan', 'peerdns');
		var dnsList = uci.get('network', 'wan', 'dns');
		var dnsStr = Array.isArray(dnsList) ? dnsList.join(' ') : (dnsList || '');
		var ispDnsStr = this.ispDns.join(' ');
		var mode;
		if (peerdns === '0' && dnsStr === PUBLIC_DNS) {
			mode = 'public';
		} else if (peerdns === '0' && ispDnsStr && dnsStr === ispDnsStr) {
			mode = 'isp_ip';
		} else if (peerdns === '0' && dnsStr) {
			mode = 'custom';
		} else {
			mode = 'isp';
		}
		return { mode: mode, dns: dnsStr };
	},

	dnsLabel: function (cfg) {
		if (cfg.mode === 'public') return 'Публичный DNS (' + PUBLIC_DNS + ') — обходит DNS-подмену провайдера';
		if (cfg.mode === 'isp_ip') return 'DNS провайдера напрямую по IP (' + (cfg.dns || this.ispDns.join(' ')) + ') — зафиксировано, не меняется вместе с DHCP';
		if (cfg.mode === 'custom') return 'Свой DNS (' + cfg.dns + ')';
		return 'DNS провайдера (авто, по умолчанию) — некоторые домены могут не резолвиться из-за блокировки на уровне DNS';
	},

	applyDns: function (cfg) {
		if (cfg.mode === 'isp') {
			// don't touch 'dns' at all — with peerdns=1, OpenWrt ignores the
			// static dns list regardless of whatever stale value sits there,
			// and deleting the option outright hits an ACL permission wall
			// that plain set() to a real value doesn't.
			uci.set('network', 'wan', 'peerdns', '1');
		} else {
			uci.set('network', 'wan', 'peerdns', '0');
			var raw = (cfg.mode === 'public') ? PUBLIC_DNS : (cfg.mode === 'isp_ip') ? this.ispDns.join(' ') : cfg.dns;
			uci.set('network', 'wan', 'dns', raw.split(/\s+/).filter(Boolean));
		}
		return uci.save()
			.then(function () { return fs.exec('/etc/init.d/network', [ 'restart' ]); });
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
		var psOutput = (data[2] && data[2].stdout) || '';
		var running = this.isRunning(psOutput);
		var cfg = this.getCurrentConfig();
		this.prevValues = cfg;

		// ubus's dns-server field reflects whatever is CURRENTLY effective on
		// the interface — once our own override (peerdns=0) is active, it just
		// echoes that override back, not what the ISP actually handed out.
		// Only trust it while peerdns=1 (auto/ISP mode) is genuinely active.
		var peerdnsNow = uci.get('network', 'wan', 'peerdns');
		this.ispDnsAvailable = (peerdnsNow !== '0');
		this.ispDns = this.ispDnsAvailable ? (data[3] || []) : [];

		var dnsCfg = this.getDnsConfig();
		this.prevDns = dnsCfg;

		var statusBadge = E('span', {
			'id': 'zr-status-badge',
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

		var dnsStatusText = E('span', { 'id': 'zr-dns-status-text' }, this.dnsLabel(dnsCfg));

		var ispIpDisabled = !this.ispDnsAvailable || !this.ispDns.length;
		var ispIpLabel = this.ispDnsAvailable
			? ('DNS провайдера по IP (' + (this.ispDns.join(', ') || 'не определён') + ')')
			: 'DNS провайдера по IP (сначала включи «DNS провайдера (авто)» и сохрани, чтобы его определить)';

		var dnsModeOptions = [
			{ key: 'isp', label: 'DNS провайдера (авто)' },
			{ key: 'public', label: 'Публичный DNS (8.8.8.8, 1.1.1.1)' },
			{ key: 'isp_ip', label: ispIpLabel, disabled: ispIpDisabled },
			{ key: 'custom', label: 'Свой DNS' }
		];
		var dnsRadios = E('div', { 'id': 'zr-dns-radios', 'style': 'display:flex;gap:18px;flex-wrap:wrap;margin:10px 0;' },
			dnsModeOptions.map(function (opt) {
				var attrs = { type: 'radio', name: 'zr-dns-mode', value: opt.key,
					'click': function () {
						document.getElementById('zr-dns-custom-row').style.display = (opt.key === 'custom') ? 'block' : 'none';
					}
				};
				if (opt.key === dnsCfg.mode) attrs.checked = 'checked';
				if (opt.disabled) attrs.disabled = 'disabled';
				return E('label', { 'style': 'display:flex;align-items:center;gap:6px;' + (opt.disabled ? 'opacity:0.5;' : '') }, [
					E('input', attrs),
					opt.label
				]);
			})
		);

		var dnsCustomInput = E('input', {
			'type': 'text', 'id': 'zr-dns-custom', 'placeholder': 'например: 9.9.9.9 94.140.14.14',
			'value': (dnsCfg.mode === 'custom') ? dnsCfg.dns : '', 'style': 'width:100%;max-width:420px;'
		});
		var dnsCustomRow = E('div', {
			'id': 'zr-dns-custom-row',
			'style': 'display:' + (dnsCfg.mode === 'custom' ? 'block' : 'none') + ';margin-bottom:10px;'
		}, [ E('label', { 'class': 'field-label', 'style': 'display:block;margin-bottom:4px;' }, 'Свои DNS-серверы (через пробел)'), dnsCustomInput ]);

		var dnsApplyBtn = E('button', {
			'id': 'zr-dns-apply-btn',
			'class': 'cbi-button cbi-button-apply',
			'click': ui.createHandlerFn(this, 'handleDnsApply')
		}, 'Применить DNS');

		var dnsRevertBox = E('div', {
			'id': 'zr-dns-revert-box',
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
			revertBox,

			E('h3', { 'style': 'margin-top:32px;' }, 'DNS'),
			E('p', { 'class': 'cbi-value-description' },
				'Провайдер может не только резать/бросать соединения (это лечит zapret2), но и напрямую подделывать DNS-ответы для конкретных доменов ' +
				'(так было обнаружено с youtube.com в этой сети). Переключение на публичный DNS обходит именно это — отдельно от всего остального выше.'),
			E('p', { 'style': 'margin:10px 0;' }, [ E('strong', {}, 'Сейчас: '), dnsStatusText ]),
			dnsRadios,
			dnsCustomRow,
			dnsApplyBtn,
			dnsRevertBox
		]);

		this.container = container;
		return container;
	},

	handleServiceAction: function (action) {
		return fs.exec(env_tools.execPath, [ action ]).then(L.bind(function () {
			ui.addNotification(null, E('p', {}, 'Команда «' + action + '» выполнена.'), 'info');
			return fs.exec('/bin/busybox', [ 'ps' ]).then(L.bind(function (res) {
				var running = this.isRunning((res && res.stdout) || '');
				var badge = document.getElementById('zr-status-badge');
				if (badge) {
					badge.textContent = running ? 'РАБОТАЕТ' : 'ОСТАНОВЛЕН';
					badge.style.background = running ? '#2ea256' : '#a33';
				}
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

	handleDnsApply: function () {
		var radios = document.getElementsByName('zr-dns-mode');
		var mode = 'isp';
		for (var i = 0; i < radios.length; i++) {
			if (radios[i].checked) { mode = radios[i].value; break; }
		}
		var customDns = document.getElementById('zr-dns-custom').value.trim();

		if (mode === 'custom' && !customDns) {
			ui.addNotification(null, E('p', {}, 'Введи хотя бы один DNS-сервер.'), 'error');
			return;
		}

		var oldDns = this.prevDns;
		var newDns = { mode: mode, dns: customDns };

		this.applyDns(newDns).then(L.bind(function () {
			this.prevDns = newDns;
			var text = document.getElementById('zr-dns-status-text');
			if (text) text.textContent = this.dnsLabel(newDns);
			this.startDnsRevertCountdown(oldDns);
		}, this)).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Не удалось сменить DNS: ' + err), 'error');
		});
	},

	startDnsRevertCountdown: function (oldDns) {
		var box = document.getElementById('zr-dns-revert-box');
		var self = this;
		var seconds = REVERT_SECONDS;

		if (this.dnsRevertTimer) {
			clearInterval(this.dnsRevertTimer);
			this.dnsRevertTimer = null;
		}

		function draw() {
			box.style.display = 'block';
			box.innerHTML = '';
			box.appendChild(E('p', {}, 'DNS изменён (перезапустился сетевой стек — у всех в доме мог на секунду моргнуть интернет). ' +
				'Если что-то не так — через ' + seconds + ' сек. вернётся как было.'));
			box.appendChild(E('button', {
				'class': 'cbi-button cbi-button-positive',
				'click': function () {
					clearInterval(self.dnsRevertTimer);
					self.dnsRevertTimer = null;
					box.style.display = 'none';
					ui.addNotification(null, E('p', {}, 'DNS-настройка подтверждена.'), 'info');
				}
			}, 'Подтвердить (оставить как есть)'));
		}

		draw();
		this.dnsRevertTimer = setInterval(function () {
			seconds -= 1;
			if (seconds <= 0) {
				clearInterval(self.dnsRevertTimer);
				self.dnsRevertTimer = null;
				box.style.display = 'none';
				self.applyDns(oldDns).then(function () {
					self.prevDns = oldDns;
					var text = document.getElementById('zr-dns-status-text');
					if (text) text.textContent = self.dnsLabel(oldDns);
					ui.addNotification(null, E('p', {}, 'DNS автоматически откачен (лучше перезагрузить страницу, чтобы переключатели совпадали).'), 'warning');
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
