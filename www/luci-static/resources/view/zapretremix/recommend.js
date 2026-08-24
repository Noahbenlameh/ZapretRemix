'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require uci';
'require view.zapret2.env as env_tools';

var POOL_FILE = '/opt/zapretremix/dns-pool.txt';

var STRATEGY_HINTS = [
	{ key: 'default', title: 'По умолчанию', desc: 'Начни с неё в большинстве случаев.' },
	{ key: 'v1_by_AnonymTsk', title: 'AnonymTsk v1', desc: 'Если ресурс использует голос/звонки/Discord/Telegram-подобный UDP.' },
	{ key: 'v1_by_Schiz23', title: 'Schiz23 v1', desc: 'Альтернатива, если «По умолчанию» не помогла.' },
	{ key: 'v2_by_Schiz23', title: 'Schiz23 v2', desc: 'Ещё один вариант того же автора.' },
	{ key: 'v1_by_Routerich', title: 'Routerich v1', desc: 'Самая тяжёлая/полная — на упорные случаи, когда ничего другое не сработало.' }
];

function parseLines(text) {
	return (text || '').split('\n').map(function (l) { return l.trim(); }).filter(function (l) {
		return l.length > 0 && l.charAt(0) !== '#';
	});
}

function parseNslookup(output) {
	if (/can't find|NXDOMAIN|SERVFAIL|no servers could be reached|connection timed out/i.test(output)) {
		return { ok: false, ips: [] };
	}
	var matches = output.match(/Address\s*\d*:\s*([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/g) || [];
	var ips = matches.map(function (m) {
		var mm = /([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/.exec(m);
		return mm ? mm[1] : null;
	}).filter(Boolean);
	// first match is always the resolver's own address (127.0.0.1 or the queried server itself)
	ips.shift();
	return { ok: ips.length > 0, ips: ips };
}

return view.extend({
	pool: [],
	ispDns: [],

	load: function () {
		return Promise.all([
			fs.read(POOL_FILE).catch(function () { return ''; }),
			this.getIspDns(),
			uci.load('network')
		]);
	},

	// DNS server(s) the ISP itself handed out over DHCP — queried directly by
	// IP regardless of whatever DNS mode is currently active on the Dashboard,
	// so "what does the provider block" stays accurate even while public/custom
	// DNS is in use.
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

	render: function (data) {
		this.pool = parseLines(data[0]);

		// ubus's dns-server just echoes back whatever is currently effective —
		// once network.wan.peerdns=0 (our own override active), it reflects
		// that override, not what the ISP actually handed out over DHCP.
		var peerdnsNow = uci.get('network', 'wan', 'peerdns');
		this.ispDnsAvailable = (peerdnsNow !== '0');
		this.ispDns = this.ispDnsAvailable ? (data[1] || []) : [];

		var domainInput = E('input', { 'type': 'text', 'id': 'zr-rec-domain', 'placeholder': 'example.com', 'style': 'width:100%;max-width:420px;' });
		var checkBtn = E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': ui.createHandlerFn(this, 'handleCheck')
		}, 'Проверить и получить рекомендации');

		var resultBox = E('div', { 'id': 'zr-rec-result', 'style': 'margin-top:18px;' });
		this.resultBox = resultBox;

		var poolAddInput = E('input', { 'type': 'text', 'id': 'zr-pool-add', 'placeholder': '1.2.3.4', 'style': 'flex:1;' });

		var containerChildren = [
			E('h2', {}, 'ZapretRemix — Рекомендации'),
			E('p', { 'class': 'cbi-value-description' },
				'Быстрый диагноз для конкретного домена: проверяет, не подделывает ли провайдер DNS-ответ (и какой DNS-сервер из пула лучше использовать), ' +
				'и не блокируется ли сам путь до сервера. Если это IP-блокировка — так и скажем прямо: zapret2 тут не поможет, но стратегию для DPI-части всё равно предложим.')
		];

		if (!this.ispDnsAvailable) {
			containerChildren.push(E('p', { 'style': 'color:#c90;' },
				'DNS провайдера сейчас не определить напрямую — на Дашборде активен другой режим (публичный/свой DNS). ' +
				'Переключись на «DNS провайдера (авто)», сохрани, и вернись сюда — тогда проверка увидит настоящий IP.'));
		}

		containerChildren.push(
			E('div', { 'style': 'margin:14px 0;' }, [
				E('label', { 'class': 'field-label', 'style': 'display:block;margin-bottom:6px;' }, 'Домен'),
				domainInput
			]),
			checkBtn,
			resultBox,

			E('h3', { 'style': 'margin-top:32px;' }, 'Пул DNS-серверов'),
			E('p', { 'class': 'cbi-value-description' }, 'Список серверов, среди которых ищем лучший при проверке. Можно дополнять своими.'),
			E('div', { 'id': 'zr-pool-list', 'style': 'margin:10px 0;' }, this.renderPoolListNodes()),
			E('div', { 'style': 'display:flex;gap:8px;' }, [
				poolAddInput,
				E('button', { 'class': 'cbi-button cbi-button-apply', 'click': ui.createHandlerFn(this, 'handlePoolAdd') }, 'Добавить в пул')
			])
		);

		var container = E('div', { 'class': 'cbi-map' }, containerChildren);

		return container;
	},

	renderPoolListNodes: function () {
		return this.pool.map(L.bind(function (server) {
			return E('div', { 'style': 'display:flex;align-items:center;gap:10px;padding:3px 0;font-family:monospace;font-size:13px;' }, [
				E('span', { 'style': 'flex:1;' }, server),
				E('button', { 'class': 'cbi-button cbi-button-negative', 'click': ui.createHandlerFn(this, 'handlePoolRemove', server) }, 'Удалить')
			]);
		}, this));
	},

	savePool: function () {
		return fs.write(POOL_FILE, this.pool.join('\n') + (this.pool.length ? '\n' : ''));
	},

	refreshPoolList: function () {
		var el = document.getElementById('zr-pool-list');
		el.innerHTML = '';
		this.renderPoolListNodes().forEach(function (node) { el.appendChild(node); });
	},

	handlePoolAdd: function () {
		var input = document.getElementById('zr-pool-add');
		var v = input.value.trim();
		if (!v || this.pool.indexOf(v) !== -1) return;
		this.pool.push(v);
		this.savePool().then(L.bind(function () {
			input.value = '';
			this.refreshPoolList();
		}, this)).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
		});
	},

	handlePoolRemove: function (server) {
		this.pool = this.pool.filter(function (s) { return s !== server; });
		this.savePool().then(L.bind(function () {
			this.refreshPoolList();
		}, this)).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
		});
	},

	sanitizeDomain: function (domain) {
		return domain.replace(/[^a-zA-Z0-9.\-]/g, '');
	},

	queryDns: function (domain, server) {
		var start = Date.now();
		var args = server ? [ 'sh', '-c', 'nslookup ' + domain + ' ' + server ] : [ 'sh', '-c', 'nslookup ' + domain ];
		return fs.exec('/bin/busybox', args).then(function (res) {
			var parsed = parseNslookup((res && res.stdout) || '');
			return { server: server || '(системный)', ok: parsed.ok, ips: parsed.ips, ms: Date.now() - start };
		}).catch(function () {
			return { server: server || '(системный)', ok: false, ips: [], ms: Date.now() - start };
		});
	},

	handleCheck: function () {
		var rawDomain = document.getElementById('zr-rec-domain').value.trim();
		var domain = this.sanitizeDomain(rawDomain);
		var box = this.resultBox;

		if (!domain) {
			box.innerHTML = '';
			box.appendChild(E('p', {}, 'Введи корректный домен.'));
			return;
		}

		box.innerHTML = '';
		box.appendChild(E('p', {}, 'Проверяю DNS провайдера, пул (' + this.pool.length + ' серверов) и доступность...'));

		var self = this;
		var ispQueries = this.ispDns.map(function (s) { return self.queryDns(domain, s); });
		var poolQueries = this.pool.map(function (s) { return self.queryDns(domain, s); });

		Promise.all([
			this.queryDns(domain, null),
			Promise.all(ispQueries),
			Promise.all(poolQueries)
		]).then(function (all) {
			var systemResult = all[0];
			var ispResults = all[1];
			var poolResults = all[2];

			var poolOk = poolResults.filter(function (r) { return r.ok && r.ips.length; });
			var ispOk = ispResults.filter(function (r) { return r.ok && r.ips.length; });

			// best pool pick: fastest among those that agree with the majority pool answer
			var ipCounts = {};
			poolOk.forEach(function (r) {
				r.ips.forEach(function (ip) { ipCounts[ip] = (ipCounts[ip] || 0) + 1; });
			});
			var majorityIp = Object.keys(ipCounts).sort(function (a, b) { return ipCounts[b] - ipCounts[a]; })[0];
			var trusted = poolOk.filter(function (r) { return majorityIp && r.ips.indexOf(majorityIp) !== -1; });
			trusted.sort(function (a, b) { return a.ms - b.ms; });
			var bestServer = trusted[0];

			// provider verdict is based specifically on the ISP's own DNS
			// server(s), not the system resolver (which may already be
			// pointed at public/custom DNS on the Dashboard) — so this stays
			// accurate no matter what DNS mode is currently active.
			var providerBlocks = ispOk.length === 0 && ispResults.length > 0 && poolOk.length > 0;
			var providerMismatch = ispOk.length > 0 && majorityIp && !ispOk.some(function (r) {
				return r.ips.indexOf(majorityIp) !== -1;
			});
			var dnsBlocked = providerBlocks || providerMismatch;

			var testIp = (ispOk.length && !dnsBlocked) ? ispOk[0].ips[0] : (bestServer ? majorityIp : (systemResult.ok ? systemResult.ips[0] : null));

			if (!testIp) {
				self.renderVerdict(domain, systemResult, ispResults, poolResults, dnsBlocked, bestServer, null);
				return;
			}

			var curlStart = Date.now();
			fs.exec('/bin/busybox', [ 'sh', '-c',
				'curl --resolve ' + domain + ':443:' + testIp + ' -o /dev/null -s -S --max-time 5 https://' + domain + '/ 2>&1; echo "EXITCODE=$?"'
			]).then(function (res) {
				var out = (res && res.stdout) || '';
				var m = /EXITCODE=(\d+)/.exec(out);
				var code = m ? parseInt(m[1], 10) : -1;
				self.renderVerdict(domain, systemResult, ispResults, poolResults, dnsBlocked, bestServer, { code: code, ms: Date.now() - curlStart, raw: out });
			});
		});
	},

	renderVerdict: function (domain, systemResult, ispResults, poolResults, dnsBlocked, bestServer, curlResult) {
		var box = this.resultBox;
		box.innerHTML = '';

		var ispTable = E('div', { 'style': 'margin:10px 0;font-family:monospace;font-size:12px;' },
			ispResults.length
				? ispResults.map(function (r) {
					return E('div', {}, r.server + ' (провайдер) — ' + (r.ok ? r.ips.join(', ') : 'нет ответа/NXDOMAIN'));
				})
				: [ E('div', {}, 'DNS провайдера не определён автоматически (нет данных DHCP).') ]
		);

		var dnsTable = E('div', { 'style': 'margin:10px 0;font-family:monospace;font-size:12px;' },
			poolResults.map(function (r) {
				return E('div', {}, r.server + ' — ' + (r.ok ? (r.ips.join(', ') + ' (' + r.ms + 'мс)') : 'нет ответа/NXDOMAIN'));
			})
		);

		var parts = [];
		parts.push(E('h3', {}, 'DNS'));
		parts.push(E('p', {}, 'Сейчас используется (системный резолвер): ' + (systemResult.ok ? systemResult.ips.join(', ') : 'не резолвит')));
		parts.push(E('p', { 'style': 'margin-top:10px;' }, E('strong', {}, 'Провайдер напрямую:')));
		parts.push(ispTable);
		parts.push(E('p', { 'style': 'margin-top:10px;' }, E('strong', {}, 'Пул:')));
		parts.push(dnsTable);

		if (dnsBlocked && bestServer) {
			parts.push(E('p', { 'style': 'color:#c90;font-weight:bold;' },
				'Провайдер подделывает/блокирует DNS-ответ для этого домена. Рекомендуем: ' + bestServer.server + ' (' + bestServer.ms + 'мс). ' +
				'Переключить можно на Дашборде («Свой DNS» → ' + bestServer.server + ', или «Публичный DNS», если это 8.8.8.8/1.1.1.1).'));
		} else if (ispResults.length && !ispResults.every(function (r) { return !r.ok; }) && poolResults.every(function (r) { return !r.ok; })) {
			parts.push(E('p', {}, 'Ни один резолвер (включая пул) не смог разрешить домен — вероятно, домен просто не существует, или проблема шире DNS.'));
		} else {
			parts.push(E('p', { 'style': 'color:#3a3;' }, 'Провайдер этот домен по DNS не блокирует.'));
		}

		parts.push(E('h3', { 'style': 'margin-top:20px;' }, 'Доступность'));
		if (!curlResult) {
			parts.push(E('p', {}, 'Не удалось проверить (нет рабочего IP для теста).'));
		} else if (curlResult.code === 0) {
			parts.push(E('p', { 'style': 'color:#3a3;font-weight:bold;' }, 'Домен доступен без обхода блокировок вообще.'));
		} else if (curlResult.code === 28) {
			parts.push(E('p', { 'style': 'color:#c33;font-weight:bold;' },
				'Похоже на блокировку по IP (соединение просто не отвечает, код curl 28). ' +
				'zapret2 здесь принципиально не поможет — пакеты не доходят до момента, где можно применить трюк. ' +
				'Нужен VPN/прокси — это уже вне рамок этого инструмента. Ниже всё равно предлагаем стратегию — ' +
				'пригодится, если решишь вопрос с IP отдельно (например, через VPN, который сам возьмёт на себя обход IP-блокировки).'));
		} else {
			parts.push(E('p', { 'style': 'color:#c90;font-weight:bold;' },
				'Похоже на DPI-блокировку (curl завершился с кодом ' + curlResult.code + ', не таймаут) — стоит пробовать стратегии обхода ниже, ' +
				'или запустить полный анализ на вкладке «Тест и анализ» для точного подбора.'));
		}

		parts.push(E('h3', { 'style': 'margin-top:20px;' }, 'Стратегия'));
		parts.push(E('p', { 'class': 'cbi-value-description' }, 'Порядок, в котором стоит пробовать (применяются на вкладке «Стратегии»):'));
		parts.push(E('div', {}, STRATEGY_HINTS.map(function (s, i) {
			return E('p', { 'style': 'margin:4px 0;' }, [ (i + 1) + '. ', E('strong', {}, s.title), ' — ' + s.desc ]);
		})));

		parts.push(E('div', { 'style': 'margin-top:16px;' }, E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': ui.createHandlerFn(this, 'handleAddToResources', domain)
		}, 'Добавить «' + domain + '» в Ресурсы')));

		parts.forEach(function (p) { box.appendChild(p); });
	},

	handleAddToResources: function (domain) {
		fs.read(env_tools.hostsUserFN).catch(function () { return ''; }).then(function (text) {
			var lines = (text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
			if (lines.indexOf(domain) === -1) lines.push(domain);
			return fs.write(env_tools.hostsUserFN, lines.join('\n') + '\n');
		}).then(function () {
			return fs.exec(env_tools.execPath, [ 'restart' ]);
		}).then(function () {
			ui.addNotification(null, E('p', {}, domain + ' добавлен в Ресурсы.'), 'info');
		}).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
