'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require uci';
'require view.zapret2.env as env_tools';

var POOL_FILE = '/opt/zapretremix/dns-pool.txt';
var PIN_BLOCKS_FILE = '/opt/zapretremix/pin-blocks.txt';
var TEST_HOSTS_FILE = '/opt/zapretremix/test-hosts.txt';
var TEST_OPT_FILE = '/opt/zapretremix/test-opt.txt';

// Same 4 templatable presets as pins.js/strategies.js (v1_by_Routerich
// excluded everywhere — too complex/hardcoded to safely templatize).
// Duplicated here rather than shared via a common module, same tradeoff
// as elsewhere in this app (only a couple of files need it).
var STRATEGY_TITLES = {
	default: 'По умолчанию',
	v1_by_AnonymTsk: 'AnonymTsk v1',
	v1_by_Schiz23: 'Schiz23 v1',
	v2_by_Schiz23: 'Schiz23 v2'
};
var TEST_ORDER = [ 'default', 'v1_by_AnonymTsk', 'v1_by_Schiz23', 'v2_by_Schiz23' ];
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

function fillPinTemplate(presetKey, hostFile) {
	var tmpl = PIN_TEMPLATES[presetKey] || PIN_TEMPLATES.default;
	return tmpl.replace(/<HOSTLIST_NOAUTO>/g, '--hostlist=' + hostFile).replace(/<HOSTLIST>/g, '--hostlist=' + hostFile);
}

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
				self.renderVerdict(domain, systemResult, ispResults, poolResults, dnsBlocked, bestServer, null, null);
				return;
			}

			var curlStart = Date.now();
			fs.exec('/bin/busybox', [ 'sh', '-c',
				'curl --resolve ' + domain + ':443:' + testIp + ' -o /dev/null -s -S --max-time 5 https://' + domain + '/ 2>&1; echo "EXITCODE=$?"'
			]).then(function (res) {
				var out = (res && res.stdout) || '';
				var m = /EXITCODE=(\d+)/.exec(out);
				var code = m ? parseInt(m[1], 10) : -1;
				self.renderVerdict(domain, systemResult, ispResults, poolResults, dnsBlocked, bestServer, { code: code, ms: Date.now() - curlStart, raw: out }, testIp);
			});
		});
	},

	renderVerdict: function (domain, systemResult, ispResults, poolResults, dnsBlocked, bestServer, curlResult, testIp) {
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

		if (curlResult && curlResult.code !== 0 && testIp) {
			parts.push(E('p', { 'class': 'cbi-value-description' },
				'Реально проверим каждую из наших стратегий против этого домена (не статичная подсказка) — по очереди применяем, тестируем, откатываем. ' +
				'Это займёт около 30-40 секунд, и на это время у остальных в доме временно пропадёт общий обход блокировок — тестируем только этот один домен.'));
			parts.push(E('div', { 'style': 'margin:10px 0;' }, E('button', {
				'class': 'cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, 'handleTestStrategies', domain, testIp)
			}, '▶ Протестировать стратегии автоматически')));
			parts.push(E('div', { 'id': 'zr-strat-test-progress' }));
		} else if (curlResult && curlResult.code === 0) {
			parts.push(E('p', { 'class': 'cbi-value-description' }, 'Домен и так доступен без обхода — тестировать стратегии не требуется.'));
		} else {
			parts.push(E('p', { 'class': 'cbi-value-description' }, 'Не удалось определить IP для теста стратегий.'));
		}

		parts.push(E('div', { 'style': 'margin-top:16px;' }, E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': ui.createHandlerFn(this, 'handleAddToResources', domain)
		}, 'Добавить «' + domain + '» в Ресурсы')));

		parts.forEach(function (p) { box.appendChild(p); });
	},

	handleTestStrategies: function (domain, testIp) {
		var progress = document.getElementById('zr-strat-test-progress');
		var self = this;
		var results = [];

		function setProgress(node) {
			progress.innerHTML = '';
			progress.appendChild(node);
		}

		setProgress(E('p', { 'style': 'color:#888;' }, 'Сохраняю текущую конфигурацию...'));

		fs.exec('/opt/zapretremix/test-strategy.sh', [ 'backup' ])
			.then(function () { return fs.write(TEST_HOSTS_FILE, domain + '\n'); })
			.then(function () {
				return TEST_ORDER.reduce(function (chain, presetKey) {
					return chain.then(function () {
						setProgress(E('p', { 'style': 'color:#888;' }, 'Пробую «' + STRATEGY_TITLES[presetKey] + '» (' + (results.length + 1) + '/' + TEST_ORDER.length + ')...'));
						var opt = fillPinTemplate(presetKey, TEST_HOSTS_FILE);
						return fs.write(TEST_OPT_FILE, opt)
							.then(function () { return fs.exec('/opt/zapretremix/test-strategy.sh', [ 'apply' ]); })
							.then(function () {
								return fs.exec('/bin/busybox', [ 'sh', '-c',
									'curl --resolve ' + domain + ':443:' + testIp + ' -o /dev/null -s -S --max-time 5 https://' + domain + '/ 2>&1; echo "EXITCODE=$?"'
								]);
							})
							.then(function (res) {
								var out = (res && res.stdout) || '';
								var m = /EXITCODE=(\d+)/.exec(out);
								var code = m ? parseInt(m[1], 10) : -1;
								results.push({ preset: presetKey, code: code, ok: code === 0 });
							});
					});
				}, Promise.resolve());
			})
			.then(function () {
				setProgress(E('p', { 'style': 'color:#888;' }, 'Возвращаю обычную конфигурацию...'));
				return fs.exec('/opt/zapretremix/test-strategy.sh', [ 'restore' ]);
			})
			.then(function () { self.renderStrategyTestResults(domain, results, progress); })
			.catch(function (err) {
				fs.exec('/opt/zapretremix/test-strategy.sh', [ 'restore' ]).catch(function () {});
				setProgress(E('p', { 'style': 'color:#c33;' }, 'Ошибка теста (конфигурация возвращена обратно): ' + err));
			});
	},

	renderStrategyTestResults: function (domain, results, progress) {
		progress.innerHTML = '';
		var anyWorked = results.some(function (r) { return r.ok; });

		progress.appendChild(E('p', { 'style': 'font-weight:bold;margin:10px 0 6px;' },
			anyWorked ? 'Готово — есть рабочие варианты:' : 'Готово — ни одна из наших стратегий не помогла.'));

		results.forEach(L.bind(function (r) {
			var badge = r.ok
				? E('span', { 'style': 'color:#3a3;font-weight:bold;' }, '✓ Работает')
				: E('span', { 'style': 'color:#c33;' }, '✗ Код ' + r.code);
			var row = E('div', { 'style': 'display:flex;align-items:center;gap:14px;padding:6px 0;border-bottom:1px solid #3335;' }, [
				E('span', { 'style': 'flex:1;' }, STRATEGY_TITLES[r.preset] || r.preset),
				badge
			]);
			if (r.ok) {
				row.appendChild(E('button', {
					'class': 'cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, 'handlePinResult', domain, r.preset)
				}, 'Закрепить'));
			}
			progress.appendChild(row);
		}, this));

		if (!anyWorked) {
			progress.appendChild(E('p', { 'style': 'margin-top:10px;' },
				'Стоит попробовать полный перебор на вкладке «Тест и анализ» — он проверяет намного больше вариантов (десятки), просто заметно дольше (10-30 минут).'));
		}
	},

	// pins.json entries are { id, domains: [...] } as of the multi-domain pin
	// change (see pins.js) — this only ever creates single-domain pins from a
	// test result, but reads/writes the current shape so it stays compatible
	// with entries edited afterward on the Закреплённые tab.
	handlePinResult: function (domain, presetKey) {
		var self = this;
		var id = domain.replace(/[^a-zA-Z0-9.\-]/g, '_');
		fs.read('/opt/zapretremix/pins.json').catch(function () { return '[]'; }).then(function (text) {
			var pins;
			try { pins = JSON.parse(text); } catch (e) { pins = []; }
			var exists = pins.some(function (p) {
				return (p.id && p.id === id) || p.domain === domain ||
					(Array.isArray(p.domains) && p.domains.indexOf(domain) !== -1);
			});
			if (exists) {
				ui.addNotification(null, E('p', {}, 'Этот домен уже закреплён — измени на вкладке «Закреплённые».'), 'warning');
				return null;
			}
			pins.push({ id: id, domains: [ domain ], preset: presetKey, dns: '' });
			var pinFile = '/opt/zapretremix/pin-hosts/' + id + '.txt';
			return fs.exec('/bin/busybox', [ 'mkdir', '-p', '/opt/zapretremix/pin-hosts' ])
				.then(function () { return fs.write(pinFile, domain + '\n'); })
				.then(function () { return fs.write('/opt/zapretremix/pins.json', JSON.stringify(pins, null, 2)); })
				.then(function () { return self.rebuildWithPins(pins); })
				.then(function () {
					ui.addNotification(null, E('p', {}, domain + ' закреплён со стратегией «' + STRATEGY_TITLES[presetKey] + '».'), 'info');
				});
		}).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
		});
	},

	rebuildWithPins: function (pins) {
		var extra = pins.map(function (pin) {
			var firstDomain = (Array.isArray(pin.domains) && pin.domains.length) ? pin.domains[0] : pin.domain;
			var id = pin.id || firstDomain.replace(/[^a-zA-Z0-9.\-]/g, '_');
			var pinFile = '/opt/zapretremix/pin-hosts/' + id + '.txt';
			return '--new\n' + fillPinTemplate(pin.preset, pinFile);
		}).join('\n\n');

		return fs.write(PIN_BLOCKS_FILE, extra)
			.then(function () {
				return fs.exec('/bin/busybox', [ 'sh', '-c', 'grep -o "Strategy__[a-zA-Z_0-9]*" /opt/zapret2/config 2>/dev/null | head -1' ]);
			})
			.then(function (res) {
				var m = /Strategy__(\S+)/.exec((res && res.stdout) || '');
				var presetKey = (m && PIN_TEMPLATES[m[1]]) ? m[1] : 'default';
				return fs.exec('/opt/zapretremix/rebuild-opt.sh', [ presetKey ]);
			})
			.then(function () { return fs.exec(env_tools.syncCfgPath, []); })
			.then(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); });
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
