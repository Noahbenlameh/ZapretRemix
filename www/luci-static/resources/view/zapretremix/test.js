'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require view.zapret2.env as env_tools';

var OUT_FILE = '/tmp/zr-test-output.log';
var DONE_MARK = '###ZRDONE###';

return view.extend({
	render: function () {
		var domainInput = E('input', { 'type': 'text', 'id': 'zr-test-domain', 'placeholder': 'example.com', 'style': 'width:100%;max-width:420px;' });
		var insecureCheck = E('input', { 'type': 'checkbox', 'id': 'zr-test-insecure' });

		var runBtn = E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': ui.createHandlerFn(this, 'handleRun')
		}, 'Запустить проверку в фоне');

		var refreshBtn = E('button', {
			'class': 'cbi-button',
			'click': ui.createHandlerFn(this, 'handleRefresh')
		}, 'Показать текущий результат');

		var stopBtn = E('button', {
			'class': 'cbi-button cbi-button-negative',
			'click': ui.createHandlerFn(this, 'handleAbort')
		}, 'Остановить проверку');

		var outputBox = E('pre', {
			'id': 'zr-test-output',
			'style': 'margin-top:16px;padding:12px;background:#111;color:#ddd;border-radius:4px;min-height:80px;white-space:pre-wrap;font-size:12px;max-height:480px;overflow:auto;'
		}, 'Здесь появится результат.');

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Тест и анализ'),
			E('p', { 'class': 'cbi-value-description' },
				'Это настоящий blockcheck2.sh (останавливает zapret2 на время теста) — перебирает десятки готовых стратегий против конкретного домена. ' +
				'Это НЕ быстро — обычно 10-30 минут, даже в сокращённом режиме. Запускается в фоне на роутере — можно закрыть страницу и вернуться позже, ' +
				'проверка продолжит идти. zapret2 запустится обратно автоматически по завершении.'),
			E('div', { 'style': 'margin:14px 0;' }, [
				E('label', { 'class': 'field-label', 'style': 'display:block;margin-bottom:6px;' }, 'Домен'),
				domainInput
			]),
			E('label', { 'style': 'display:flex;align-items:center;gap:8px;margin-bottom:14px;' }, [
				insecureCheck,
				'Игнорировать проверку сертификата сервера (-k) — для сайтов с нестандартным/несовпадающим сертификатом'
			]),
			E('div', { 'style': 'display:flex;gap:8px;' }, [ runBtn, refreshBtn, stopBtn ]),
			outputBox
		]);
	},

	sanitizeDomain: function (domain) {
		return domain.replace(/[^a-zA-Z0-9.\-]/g, '');
	},

	buildAnswers: function (domain) {
		// wizard sequence: test-type, domain, ip-version, http?, tls1.2?, tls1.3?, repeats, parallel?, thoroughness
		return [ '2', domain, '4', 'N', 'Y', 'N', '1', 'N', '1', '' ].join('\\n') + '\\n';
	},

	shQuote: function (s) {
		return "'" + String(s).replace(/'/g, "'\\''") + "'";
	},

	isBusy: function () {
		return fs.exec('/bin/busybox', [ 'sh', '-c', 'ps | grep blockcheck2.sh | grep -v grep' ])
			.then(function (res) { return !!((res && res.stdout || '').trim()); });
	},

	handleRun: function () {
		var rawDomain = document.getElementById('zr-test-domain').value.trim();
		var domain = this.sanitizeDomain(rawDomain);
		var insecure = document.getElementById('zr-test-insecure').checked;
		var out = document.getElementById('zr-test-output');

		if (!domain) {
			out.textContent = 'Введи корректный домен.';
			return;
		}

		this.isBusy().then(L.bind(function (busy) {
			if (busy) {
				out.textContent = 'Проверка уже идёт (другой домен?) — сначала «Остановить проверку» или дождись её завершения.';
				return;
			}

			out.textContent = 'Запущено в фоне. Это надолго (10-30 минут) — можно уйти со страницы и вернуться, нажать «Показать текущий результат» в любой момент.';

			var prefix = insecure ? 'CURL_OPT=-k ' : '';
			var testCmd = 'printf "' + this.buildAnswers(domain) + '" | ' + prefix + env_tools.appDir + '/blockcheck2.sh';
			var inner = '{ ' + env_tools.execPath + ' stop; ' + testCmd + '; ' + env_tools.execPath + ' start; echo ' + DONE_MARK + '; } >' + OUT_FILE + ' 2>&1 </dev/null';
			var launch = 'rm -f ' + OUT_FILE + '; setsid /bin/busybox sh -c ' + this.shQuote(inner) + ' >/dev/null 2>&1 </dev/null &';

			fs.exec('/bin/busybox', [ 'sh', '-c', launch ]).catch(function (err) {
				out.textContent = 'Не удалось запустить: ' + err;
			});
		}, this));
	},

	handleRefresh: function () {
		var out = document.getElementById('zr-test-output');
		out.textContent = 'Читаю...';
		fs.exec('/bin/busybox', [ 'sh', '-c', 'cat ' + OUT_FILE + ' 2>/dev/null' ])
			.then(L.bind(function (res) {
				var text = (res && res.stdout) || '';
				if (!text) {
					out.textContent = '(файла результата ещё нет — проверка не запускалась, или ещё не успела ничего записать)';
					return;
				}
				var done = text.indexOf(DONE_MARK) !== -1;
				out.textContent = text.replace(DONE_MARK, '').trim() + (done ? '\n\n=== ЗАВЕРШЕНО ===' : '\n\n(ещё выполняется...)');
			}, this))
			.catch(function (err) {
				out.textContent = 'Ошибка: ' + err;
			});
	},

	handleAbort: function () {
		var out = document.getElementById('zr-test-output');
		fs.exec('/bin/busybox', [ 'sh', '-c', 'killall blockcheck2.sh 2>/dev/null; killall curl 2>/dev/null' ])
			.then(L.bind(function () {
				return fs.exec(env_tools.execPath, [ 'start' ]);
			}, this))
			.then(function () {
				out.textContent = 'Проверка остановлена, zapret2 запущен обратно.';
			})
			.catch(function (err) {
				out.textContent = 'Ошибка: ' + err;
			});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
