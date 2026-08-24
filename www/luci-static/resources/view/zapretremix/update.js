'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require view.zapret2.env as env_tools';

return view.extend({
	render: function () {
		var checkBtn = E('button', {
			'class': 'cbi-button',
			'click': ui.createHandlerFn(this, 'handleRun', [ '-c' ])
		}, 'Проверить обновления');

		var updateBtn = E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': ui.createHandlerFn(this, 'handleRun', [ '-u', '2' ])
		}, 'Обновить до последней версии (zapret2)');

		var outputBox = E('pre', {
			'id': 'zr-update-output',
			'style': 'margin-top:16px;padding:12px;background:#111;color:#ddd;border-radius:4px;min-height:120px;white-space:pre-wrap;font-size:12px;max-height:420px;overflow:auto;'
		}, 'Здесь появится вывод.');

		this.outputBox = outputBox;

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Обновление'),
			E('p', { 'class': 'cbi-value-description' },
				'Обновление касается только самого zapret2 (пакеты zapret2/luci-app-zapret2). ZapretRemix обновляется отдельно, той же командой через GitHub, что и при установке.'),
			E('div', { 'style': 'display:flex;gap:8px;' }, [ checkBtn, updateBtn ]),
			outputBox
		]);
	},

	handleRun: function (args) {
		this.outputBox.textContent = 'Выполняется...';
		fs.exec(env_tools.appDir + '/update-pkg.sh', args)
			.then(L.bind(function (res) {
				this.outputBox.textContent = (res && (res.stdout || res.stderr)) || '(пустой вывод)';
			}, this))
			.catch(L.bind(function (err) {
				this.outputBox.textContent = 'Ошибка: ' + err;
			}, this));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
