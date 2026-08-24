'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require view.zapret2.env as env_tools';

return view.extend({
	render: function () {
		var domainInput = E('input', { 'type': 'text', 'id': 'zr-test-domain', 'placeholder': 'example.com', 'style': 'width:100%;max-width:420px;' });
		var insecureCheck = E('input', { 'type': 'checkbox', 'id': 'zr-test-insecure' });

		var runBtn = E('button', {
			'class': 'cbi-button cbi-button-apply',
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
				'Это не полный blockcheck2.sh (тот может идти 10-30+ минут) — для глубокого анализа используй его по SSH напрямую.'),
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

	buildStdin: function (domain, insecure) {
		// wizard sequence: test-type, domain, ip-version, http?, tls1.2?, tls1.3?, repeats, parallel?, thoroughness
		return [ '2', domain, '4', 'N', 'Y', 'N', '1', 'N', '1', '' ].join('\n');
	},

	handleRun: function () {
		var domain = document.getElementById('zr-test-domain').value.trim();
		var insecure = document.getElementById('zr-test-insecure').checked;
		var out = document.getElementById('zr-test-output');

		if (!domain) {
			out.textContent = 'Введи домен.';
			return;
		}

		out.textContent = 'Останавливаю zapret2 и запускаю проверку (может занять до минуты)...';

		var env = insecure ? [ 'sh', '-c', 'CURL_OPT=-k ' + env_tools.appDir + '/blockcheck2.sh' ]
		                    : [ 'sh', '-c', env_tools.appDir + '/blockcheck2.sh' ];

		fs.exec(env_tools.execPath, [ 'stop' ])
			.then(L.bind(function () {
				return fs.exec('/bin/busybox', env, this.buildStdin(domain, insecure));
			}, this))
			.then(L.bind(function (res) {
				out.textContent = (res && (res.stdout || res.stderr)) || '(пустой вывод)';
			}, this))
			.catch(function (err) {
				out.textContent = 'Ошибка: ' + err;
			})
			.then(L.bind(function () {
				return fs.exec(env_tools.execPath, [ 'start' ]);
			}, this))
			.catch(function () { /* best effort restart */ });
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
