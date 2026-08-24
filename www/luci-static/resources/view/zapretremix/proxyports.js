'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require uci';
'require view.zapret2.env as env_tools';
'require view.zapretremix.shared as shared';

var PROFILES_FILE = '/opt/zapretremix/proxy-profiles.json';
var PORT_BLOCKS_FILE = '/opt/zapretremix/pin-ports-blocks.txt';
// Deliberately separate from recommend.js's test-opt.txt (domain strategy
// test) — sharing one file risked the two tests clobbering each other's
// in-flight content if both ran around the same time.
var TEST_OPT_FILE = '/opt/zapretremix/port-test-opt.txt';

function newId() {
	return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

// curl is invoked via PATH (busybox sh -c), same as everywhere else in this
// app, rather than a hardcoded absolute path that was never actually
// verified to exist on this router. SOCKS5 uses --socks5-hostname (resolves
// the target through the proxy itself, not the router's own DNS) so the
// test reflects the proxy's own path end-to-end; HTTP-proxy mode (-x)
// always resolves through the proxy anyway. Host/port/login/password travel
// as ENV VARS (fs.exec's 3rd param), referenced in the command string only
// via double-quoted "$VAR" — shell does variable substitution but does NOT
// re-parse the substituted value for metacharacters, so credentials
// containing quotes/semicolons/backticks stay inert instead of being
// interpreted as shell syntax.
function buildCurlEnv(profile, target) {
	return {
		ZR_HOST: profile.host,
		ZR_PORT: String(profile.port),
		ZR_USER: profile.user || '',
		ZR_PASS: profile.pass || '',
		ZR_TARGET: target || 'https://www.google.com/'
	};
}

function buildCurlCmd(profile) {
	var proxyFlag = (profile.type === 'http')
		? '-x "http://$ZR_HOST:$ZR_PORT"'
		: '--socks5-hostname "$ZR_HOST:$ZR_PORT"';
	var authFlag = profile.user ? '-U "$ZR_USER:$ZR_PASS"' : '';
	return 'curl ' + proxyFlag + ' ' + authFlag + ' --max-time 8 -o /dev/null -s -S "$ZR_TARGET" 2>&1; echo "EXITCODE=$?"';
}

return view.extend({
	profiles: [],

	load: function () {
		return Promise.all([
			fs.read(PROFILES_FILE).catch(function () { return '[]'; }),
			uci.load('zapret2')
		]);
	},

	currentPortsTcp: function () {
		return uci.get('zapret2', 'config', 'NFQWS2_PORTS_TCP') || '80,443';
	},

	render: function (data) {
		try { this.profiles = JSON.parse(data[0] || '[]'); } catch (e) { this.profiles = []; }

		var nameInput = E('input', { 'type': 'text', 'id': 'zr-pp-name', 'placeholder': 'Например: Мобильный прокси #1', 'style': 'width:100%;max-width:300px;' });
		var typeSelect = E('select', { 'id': 'zr-pp-type', 'style': 'width:140px;' }, [
			E('option', { value: 'socks5' }, 'SOCKS5'),
			E('option', { value: 'http' }, 'HTTP')
		]);
		var hostInput = E('input', { 'type': 'text', 'id': 'zr-pp-host', 'placeholder': 'IP или домен', 'style': 'width:180px;' });
		var portInput = E('input', { 'type': 'text', 'id': 'zr-pp-port', 'placeholder': 'порт', 'style': 'width:90px;' });
		var userInput = E('input', { 'type': 'text', 'id': 'zr-pp-user', 'placeholder': 'логин (необязательно)', 'style': 'width:160px;' });
		var passInput = E('input', { 'type': 'password', 'id': 'zr-pp-pass', 'placeholder': 'пароль', 'style': 'width:140px;' });
		var dnsInput = E('input', { 'type': 'text', 'id': 'zr-pp-dns', 'placeholder': 'DNS прокси (для памяти, необязательно)', 'style': 'width:220px;' });
		var rotateInput = E('input', { 'type': 'text', 'id': 'zr-pp-rotate', 'placeholder': 'ссылка смены IP (необязательно)', 'style': 'width:260px;' });

		var addBtn = E('button', { 'class': 'cbi-button cbi-button-apply', 'click': ui.createHandlerFn(this, 'handleAdd') }, 'Добавить прокси');

		var listBox = E('div', { 'id': 'zr-pp-list', 'style': 'margin:16px 0;' }, this.renderList());
		this.listBox = listBox;

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Прокси по портам (эксперимент)'),
			E('p', { 'style': 'color:#c90;font-weight:bold;' }, 'Экспериментальный раздел. Работает иначе и с меньшей гарантией результата, чем остальные вкладки — читай до конца перед использованием.'),
			E('p', { 'class': 'cbi-value-description' },
				'Для SOCKS5/HTTP-прокси (и вообще любого TCP-порта без узнаваемого домена/SNI внутри) zapret2 не может смотреть на содержимое — ' +
				'домена тут нет. Вместо этого применяется "слепая" правка первых пакетов по фиксированной позиции байт, без учёта того, что внутри. ' +
				'Ниже — автоматический перебор нескольких таких вариантов против конкретного порта твоего прокси, с проверкой через реальное ' +
				'подключение (curl через сам прокси).'),
			E('p', { 'class': 'cbi-value-description' },
				'Важно: это не поможет, если сам сервер прокси заблокирован по IP (тут та же логика, что и с доменами — если соединение вообще не ' +
				'устанавливается ни с одной из комбинаций, дело не в DPI). И это не поможет с OpenVPN/WireGuard/VLESS — для них другой протокол и ' +
				'другая механика проверки, здесь их нет (см. обсуждение).'),

			E('h3', {}, 'Добавить прокси'),
			E('div', { 'style': 'display:flex;gap:8px;flex-wrap:wrap;margin:10px 0;align-items:center;' }, [
				nameInput, typeSelect, hostInput, portInput, userInput, passInput
			]),
			E('div', { 'style': 'display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px;align-items:center;' }, [
				dnsInput, rotateInput, addBtn
			]),

			E('h3', { 'style': 'margin-top:24px;' }, 'Мои прокси'),
			E('p', { 'class': 'cbi-value-description' }, [
				'Сейчас в очередь на обработку у zapret2 попадают порты: ',
				E('code', {}, this.currentPortsTcp()),
				' (поле "TCP порты" на вкладке Стратегии). После того как закрепишь рабочую комбинацию для порта прокси — обязательно добавь этот порт ' +
				'туда же вручную, иначе трафик до zapret2 просто не дойдёт и стратегия не сработает, сколько её ни закрепляй.'
			]),
			listBox
		]);
	},

	renderList: function () {
		if (!this.profiles.length) {
			return [ E('p', { 'class': 'cbi-value-description' }, 'Пока ничего не добавлено.') ];
		}
		return this.profiles.map(L.bind(function (p) {
			var comboTitle = null;
			if (p.combo) {
				var found = shared.PORT_COMBOS.filter(function (c) { return c.key === p.combo; })[0];
				comboTitle = found ? found.title : p.combo;
			}

			var statusLine = comboTitle
				? E('span', { 'style': 'color:#3a3;font-weight:bold;' }, 'Закреплено: ' + comboTitle)
				: E('span', { 'style': 'color:#888;' }, 'Стратегия не подобрана');

			var buttons = [
				E('button', { 'class': 'cbi-button cbi-button-apply', 'click': ui.createHandlerFn(this, 'handleTestClick', p.id) }, 'Подобрать автоматически')
			];
			if (p.combo) {
				buttons.push(E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'handleUnpin', p.id) }, 'Открепить'));
			}
			if (p.rotateUrl) {
				buttons.push(E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'handleRotate', p.id) }, 'Сменить IP'));
			}
			buttons.push(E('button', { 'class': 'cbi-button cbi-button-negative', 'click': ui.createHandlerFn(this, 'handleDelete', p.id) }, 'Удалить'));

			var card = E('div', { 'style': 'padding:10px 0;border-bottom:1px solid #3335;' }, [
				E('div', { 'style': 'display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;' }, [
					E('div', {}, [
						E('div', { 'style': 'font-weight:bold;' }, p.name + ' (' + p.type.toUpperCase() + ')'),
						E('div', { 'style': 'font-family:monospace;font-size:12px;color:#888;' }, p.host + ':' + p.port + (p.dns ? (' · DNS: ' + p.dns) : ''))
					]),
					statusLine
				]),
				E('div', { 'style': 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;' }, buttons),
				E('div', { 'id': 'zr-pp-progress-' + p.id, 'style': 'margin-top:8px;' })
			]);
			return card;
		}, this));
	},

	refreshList: function () {
		this.listBox.innerHTML = '';
		this.renderList().forEach(L.bind(function (node) { this.listBox.appendChild(node); }, this));
	},

	saveProfiles: function () {
		return fs.write(PROFILES_FILE, JSON.stringify(this.profiles, null, 2));
	},

	handleAdd: function () {
		var name = document.getElementById('zr-pp-name').value.trim();
		var type = document.getElementById('zr-pp-type').value;
		var host = document.getElementById('zr-pp-host').value.trim();
		var port = parseInt(document.getElementById('zr-pp-port').value.trim(), 10);
		var user = document.getElementById('zr-pp-user').value.trim();
		var pass = document.getElementById('zr-pp-pass').value;
		var dns = document.getElementById('zr-pp-dns').value.trim();
		var rotateUrl = document.getElementById('zr-pp-rotate').value.trim();

		if (!name || !host || !port || port < 1 || port > 65535) {
			ui.addNotification(null, E('p', {}, 'Заполни хотя бы название, хост и корректный порт (1-65535).'), 'error');
			return;
		}

		this.profiles.push({ id: newId(), name: name, type: type, host: host, port: port, user: user, pass: pass, dns: dns, rotateUrl: rotateUrl, combo: '' });
		this.saveProfiles().then(L.bind(function () {
			[ 'zr-pp-name', 'zr-pp-host', 'zr-pp-port', 'zr-pp-user', 'zr-pp-pass', 'zr-pp-dns', 'zr-pp-rotate' ].forEach(function (id) {
				document.getElementById(id).value = '';
			});
			this.refreshList();
		}, this)).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
		});
	},

	handleDelete: function (id) {
		var wasPinned = this.profiles.some(function (p) { return p.id === id && p.combo; });
		this.profiles = this.profiles.filter(function (p) { return p.id !== id; });
		this.saveProfiles()
			.then(L.bind(function () { return wasPinned ? this.syncPortBlocks() : null; }, this))
			.then(L.bind(function () {
				this.refreshList();
				ui.addNotification(null, E('p', {}, 'Удалено.'), 'info');
			}, this))
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	handleRotate: function (id) {
		var profile = this.profiles.filter(function (p) { return p.id === id; })[0];
		if (!profile || !profile.rotateUrl) return;
		fs.exec('/bin/busybox', [ 'sh', '-c', 'curl -s -S --max-time 10 "$ZR_TARGET"' ], { ZR_TARGET: profile.rotateUrl })
			.then(function () {
				ui.addNotification(null, E('p', {}, 'Запрос на смену IP отправлен.'), 'info');
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	// Finds the currently active global strategy by name (reading the SYNCED
	// runtime file, not the client-side uci cache — reading back a value a
	// separate shell command/rebuild just wrote turned out unreliable via
	// uci.js in practice, same lesson as pins.js/recommend.js).
	currentStrategyKey: function () {
		return fs.exec('/bin/busybox', [ 'sh', '-c', 'grep -o "Strategy__[a-zA-Z_0-9]*" /opt/zapret2/config 2>/dev/null | head -1' ])
			.then(function (res) {
				var m = /Strategy__(\S+)/.exec((res && res.stdout) || '');
				return (m && shared.PIN_TEMPLATES[m[1]]) ? m[1] : 'default';
			});
	},

	// Rebuilds NFQWS2_OPT's port-pin blocks from the current profile list and
	// restarts the daemon. Deliberately does NOT touch NFQWS2_PORTS_TCP — see
	// rebuild-opt.sh's own comment for why automating that merge is a drift
	// trap; the user adds the port there once by hand instead.
	syncPortBlocks: function () {
		var self = this;
		var extra = this.profiles.filter(function (p) { return p.combo; }).map(function (p) {
			var combo = shared.PORT_COMBOS.filter(function (c) { return c.key === p.combo; })[0];
			return combo ? ('--new\n' + combo.build(p.port)) : '';
		}).filter(Boolean).join('\n\n');

		return fs.write(PORT_BLOCKS_FILE, extra)
			.then(function () { return self.currentStrategyKey(); })
			.then(function (presetKey) { return fs.exec('/opt/zapretremix/rebuild-opt.sh', [ presetKey ]); })
			.then(function () { return fs.exec(env_tools.syncCfgPath, []); })
			.then(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); });
	},

	handleUnpin: function (id) {
		var profile = this.profiles.filter(function (p) { return p.id === id; })[0];
		if (!profile) return;
		profile.combo = '';
		this.saveProfiles()
			.then(L.bind(this.syncPortBlocks, this))
			.then(L.bind(function () {
				this.refreshList();
				ui.addNotification(null, E('p', {}, profile.name + ' откреплён.'), 'info');
			}, this))
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	handlePin: function (id, comboKey) {
		var profile = this.profiles.filter(function (p) { return p.id === id; })[0];
		if (!profile) return;
		profile.combo = comboKey;
		this.saveProfiles()
			.then(L.bind(this.syncPortBlocks, this))
			.then(L.bind(function () {
				this.refreshList();
				ui.addNotification(null, E('p', {},
					profile.name + ' закреплён. Не забудь добавить порт ' + profile.port + ' в поле "TCP порты" на вкладке Стратегии ' +
					'(сейчас там: ' + this.currentPortsTcp() + ') — без этого трафик на этот порт не попадёт в очередь zapret2.'
				), 'warning');
			}, this))
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	handleTestClick: function (id) {
		var profile = this.profiles.filter(function (p) { return p.id === id; })[0];
		if (!profile) return;
		var progress = document.getElementById('zr-pp-progress-' + id);
		var self = this;
		var results = [];

		function setProgress(node) {
			progress.innerHTML = '';
			progress.appendChild(node);
		}

		setProgress(E('p', { 'style': 'color:#888;' }, 'Сохраняю текущую конфигурацию...'));

		fs.exec('/opt/zapretremix/test-strategy-port.sh', [ 'backup' ])
			.then(function () {
				return shared.PORT_COMBOS.reduce(function (chain, combo) {
					return chain.then(function () {
						setProgress(E('p', { 'style': 'color:#888;' },
							'Пробую «' + combo.title + '» (' + (results.length + 1) + '/' + shared.PORT_COMBOS.length + ')...'));
						return fs.write(TEST_OPT_FILE, combo.build(profile.port))
							.then(function () { return fs.exec('/opt/zapretremix/test-strategy-port.sh', [ 'apply', String(profile.port) ]); })
							.then(function () {
								return fs.exec('/bin/busybox', [ 'sh', '-c', buildCurlCmd(profile) ], buildCurlEnv(profile));
							})
							.then(function (res) {
								var out = (res && res.stdout) || '';
								var m = /EXITCODE=(\d+)/.exec(out);
								var code = m ? parseInt(m[1], 10) : -1;
								results.push({ key: combo.key, title: combo.title, ok: code === 0 });
							})
							.catch(function () {
								results.push({ key: combo.key, title: combo.title, ok: false });
							});
					});
				}, Promise.resolve());
			})
			.then(function () {
				setProgress(E('p', { 'style': 'color:#888;' }, 'Возвращаю обычную конфигурацию...'));
				return fs.exec('/opt/zapretremix/test-strategy-port.sh', [ 'restore' ]);
			})
			.then(function () { self.renderTestResults(id, results, progress); })
			.catch(function (err) {
				fs.exec('/opt/zapretremix/test-strategy-port.sh', [ 'restore' ]).catch(function () {});
				setProgress(E('p', { 'style': 'color:#c33;' }, 'Ошибка теста (конфигурация возвращена обратно): ' + err));
			});
	},

	renderTestResults: function (id, results, progress) {
		progress.innerHTML = '';
		var anyWorked = results.some(function (r) { return r.ok; });

		progress.appendChild(E('p', { 'style': 'font-weight:bold;margin:8px 0 6px;' },
			anyWorked ? 'Готово — есть рабочие варианты:' : 'Готово — ни одна комбинация не помогла (похоже на блокировку по IP самого сервера прокси, а не по DPI).'));

		results.forEach(L.bind(function (r) {
			var badge = r.ok
				? E('span', { 'style': 'color:#3a3;font-weight:bold;' }, '✓ Работает')
				: E('span', { 'style': 'color:#c33;' }, '✗ Не прошло');
			var row = E('div', { 'style': 'display:flex;align-items:center;gap:14px;padding:5px 0;' }, [
				E('span', { 'style': 'flex:1;' }, r.title),
				badge,
				E('button', {
					'class': 'cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, 'handlePin', id, r.key)
				}, r.ok ? 'Закрепить' : 'Закрепить всё равно')
			]);
			progress.appendChild(row);
		}, this));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
