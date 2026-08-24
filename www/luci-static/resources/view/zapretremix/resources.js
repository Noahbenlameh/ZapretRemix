'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require view.zapret2.env as env_tools';

function parseLines(text) {
	return (text || '').split('\n').map(function (l) { return l.trim(); }).filter(function (l) {
		return l.length > 0 && l.charAt(0) !== '#';
	});
}

return view.extend({
	load: function () {
		return Promise.all([
			fs.read(env_tools.hostsUserFN).catch(function () { return ''; }),
			fs.read(env_tools.hostsUserExcludeFN).catch(function () { return ''; })
		]);
	},

	renderList: function (containerId, fn, lines) {
		var el = document.getElementById(containerId);
		el.innerHTML = '';
		if (!lines.length) {
			el.appendChild(E('div', { 'class': 'cbi-value-description' }, 'Список пуст.'));
			return;
		}
		lines.forEach(L.bind(function (domain) {
			el.appendChild(E('div', { 'style': 'display:flex;align-items:center;gap:10px;padding:4px 0;' }, [
				E('span', { 'style': 'flex:1;font-family:monospace;' }, domain),
				E('button', {
					'class': 'cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(this, 'handleRemove', [ fn, domain ])
				}, 'Удалить')
			]));
		}, this));
	},

	render: function (data) {
		this.hostLines = parseLines(data[0]);
		this.excludeLines = parseLines(data[1]);

		var hostAddInput = E('input', { 'type': 'text', 'id': 'zr-host-add', 'placeholder': 'example.com', 'style': 'flex:1;' });
		var excludeAddInput = E('input', { 'type': 'text', 'id': 'zr-exclude-add', 'placeholder': 'example.com', 'style': 'flex:1;' });

		var container = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Ресурсы'),

			E('h3', {}, 'Обычный список (к этим доменам применяется стратегия в режиме "только выбранные сайты")'),
			E('div', { 'style': 'display:flex;gap:8px;margin-bottom:10px;' }, [
				hostAddInput,
				E('button', {
					'class': 'cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, 'handleAdd', [ env_tools.hostsUserFN, 'zr-host-add', 'zr-host-list', 'hostLines' ])
				}, 'Добавить')
			]),
			E('div', { 'id': 'zr-host-list' }),

			E('h3', { 'style': 'margin-top:28px;' }, 'Исключения (к этим доменам стратегия НЕ применяется никогда)'),
			E('div', { 'style': 'display:flex;gap:8px;margin-bottom:10px;' }, [
				excludeAddInput,
				E('button', {
					'class': 'cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, 'handleAdd', [ env_tools.hostsUserExcludeFN, 'zr-exclude-add', 'zr-exclude-list', 'excludeLines' ])
				}, 'Добавить')
			]),
			E('div', { 'id': 'zr-exclude-list' }),

			E('p', { 'class': 'cbi-value-description', 'style': 'margin-top:24px;' },
				'Автоматическая загрузка официального реестра заблокированных доменов сюда пока не подключена — это следующий шаг, требует отдельной проверки скрипта загрузки, чтобы не перезаписать что-то по ошибке.')
		]);

		this.container = container;

		// deferred initial render of the two lists (needs container in DOM)
		setTimeout(L.bind(function () {
			this.renderList('zr-host-list', 'hostLines', this.hostLines);
			this.renderList('zr-exclude-list', 'excludeLines', this.excludeLines);
		}, this), 0);

		return container;
	},

	saveList: function (path, lines) {
		return fs.write(path, lines.join('\n') + (lines.length ? '\n' : ''))
			.then(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); });
	},

	handleAdd: function (args) {
		var path = args[0], inputId = args[1], listId = args[2], fieldName = args[3];
		var input = document.getElementById(inputId);
		var domain = input.value.trim();
		if (!domain) return;

		var lines = this[fieldName];
		if (lines.indexOf(domain) === -1) {
			lines.push(domain);
		}
		this.saveList(path, lines).then(L.bind(function () {
			input.value = '';
			this.renderList(listId, fieldName, lines);
			ui.addNotification(null, E('p', {}, 'Добавлено: ' + domain), 'info');
		}, this)).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Ошибка сохранения: ' + err), 'error');
		});
	},

	handleRemove: function (args) {
		var fieldName = args[0], domain = args[1];
		var path = (fieldName === 'hostLines') ? env_tools.hostsUserFN : env_tools.hostsUserExcludeFN;
		var listId = (fieldName === 'hostLines') ? 'zr-host-list' : 'zr-exclude-list';

		var lines = this[fieldName].filter(function (l) { return l !== domain; });
		this[fieldName] = lines;

		this.saveList(path, lines).then(L.bind(function () {
			this.renderList(listId, fieldName, lines);
			ui.addNotification(null, E('p', {}, 'Удалено: ' + domain), 'info');
		}, this)).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Ошибка сохранения: ' + err), 'error');
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
