'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require view.zapret2.env as env_tools';

var OUT_FILE = '/tmp/zr-test-output.log';
var DONE_MARK = '###ZRDONE###';
var POLL_MS = 2000;
var MAX_POLLS = 90; // 3 minutes safety cap

return view.extend({
	pollTimer: null,
	pollCount: 0,

	render: function () {
		var domainInput = E('input', { 'type': 'text', 'id': 'zr-test-domain', 'placeholder': 'example.com', 'style': 'width:100%;max-width:420px;' });
		var insecureCheck = E('input', { 'type': 'checkbox', 'id': 'zr-test-insecure' });

		var runBtn = E('button', {
			'class': 'cbi-button cbi-button-apply',
			'id': 'zr-test-run-btn',
			'click': ui.createHandlerFn(this, 'handleRun')
		}, 'Быстрая проверка');

		var outputBox = E('pre', {
			'id': 'zr-test-output',
			'style': 'margin-top:16px;padding:12px;background:#111;color:#ddd;border-radius:4px;min-height:80px;white-space:pre-wrap;font-size:12px;max-height:420px;overflow:auto;'
		}, 'Здесь появится результат.');

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Тест и анализ'),
			E('p', { 'class': 'cbi-value-description' },
				'Быстрая проверка: останавливает zapret2, проверяет TLS 1.2-соединение с доменом БЕЗ обхода (1 попытка, режим quick), запускает zapret2 обратно. ' +
				'Запускается в фоне на роутере, страница просто опрашивает результат — сама проверка обычно занимает 15-60 секунд. ' +
				'Это не полный blockcheck2.sh (тот перебирает много стратегий и может идти 10-30+ минут) — для глубокого анализа запускай его по SSH напрямую.'),
			E('div', { 'style': 'margin:14px 0;' }, [
				E('label', { 'class': 'field-label', 'style': 'display:block;margin-bottom:6px;' }, 'Домен'),
				domainInput
			]),
			E('label', { 'style': 'display:flex;align-items:center;gap:8px;margin-bottom:14px;' }, [
				insecureCheck,
				'Игнорировать проверку сертификата сервера (-k) — для сайтов с нестандартным/несовпадающим сертификатом'
			]),
			runBtn,
			outputBox
		]);
	},

	sanitizeDomain: function (domain) {
		return domain.replace(/[^a-zA-Z0-9.\-]/g, '');
	},

	buildAnswers: function (domain) {
		// wizard sequence: test-type, domain, ip-version, http?, tls1.2?, tls1.3?, repeats, parallel?, thoroughness
		// joined with literal \n (two chars) so printf's format string turns them into real newlines
		return [ '2', domain, '4', 'N', 'Y', 'N', '1', 'N', '1', '' ].join('\\n') + '\\n';
	},

	handleRun: function () {
		var rawDomain = document.getElementById('zr-test-domain').value.trim();
		var domain = this.sanitizeDomain(rawDomain);
		var insecure = document.getElementById('zr-test-insecure').checked;
		var out = document.getElementById('zr-test-output');
		var btn = document.getElementById('zr-test-run-btn');

		if (!domain) {
			out.textContent = 'Введи корректный домен.';
			return;
		}

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		btn.disabled = true;
		out.textContent = 'Запущено в фоне, жду результат...';

		var prefix = insecure ? 'CURL_OPT=-k ' : '';
		var testCmd = 'printf "' + this.buildAnswers(domain) + '" | ' + prefix + env_tools.appDir + '/blockcheck2.sh';

		// everything (stop, test, start, done-marker) runs as one detached
		// background job so the *launching* fs.exec call returns instantly —
		// avoids the LuCI/XHR request timeout that a single blocking call hit.
		var bg = '{ ' + env_tools.execPath + ' stop; ' + testCmd + '; ' + env_tools.execPath + ' start; ' +
			'echo ' + DONE_MARK + '; } >' + OUT_FILE + ' 2>&1 &';
		var launch = 'rm -f ' + OUT_FILE + '; ' + bg;

		fs.exec('/bin/busybox', [ 'sh', '-c', launch ])
			.then(L.bind(function () {
				this.pollCount = 0;
				this.pollTimer = setInterval(L.bind(this.pollOutput, this), POLL_MS);
			}, this))
			.catch(function (err) {
				out.textContent = 'Не удалось запустить: ' + err;
				btn.disabled = false;
			});
	},

	pollOutput: function () {
		var out = document.getElementById('zr-test-output');
		var btn = document.getElementById('zr-test-run-btn');
		this.pollCount += 1;

		fs.exec('/bin/busybox', [ 'sh', '-c', 'cat ' + OUT_FILE + ' 2>/dev/null' ])
			.then(L.bind(function (res) {
				var text = (res && res.stdout) || '';
				var done = text.indexOf(DONE_MARK) !== -1;
				out.textContent = text.replace(DONE_MARK, '').trim() || 'Запущено, жду вывод...';

				if (done || this.pollCount >= MAX_POLLS) {
					clearInterval(this.pollTimer);
					this.pollTimer = null;
					btn.disabled = false;
					if (!done) {
						out.textContent += '\n\n(превышено время ожидания — проверь вручную по SSH, что происходит)';
					}
				}
			}, this))
			.catch(L.bind(function (err) {
				clearInterval(this.pollTimer);
				this.pollTimer = null;
				btn.disabled = false;
				out.textContent = 'Ошибка опроса: ' + err;
			}, this));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
