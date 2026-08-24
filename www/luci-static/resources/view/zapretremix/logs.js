'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require uci';
'require view.zapret2.env as env_tools';

return view.extend({
	load: function () {
		return uci.load('zapret2');
	},

	render: function () {
		var enabled = (uci.get('zapret2', 'config', 'DAEMON_LOG_ENABLE') === '1');

		var toggleBtn = E('button', {
			'class': 'cbi-button ' + (enabled ? 'cbi-button-negative' : 'cbi-button-positive'),
			'click': ui.createHandlerFn(this, 'handleToggle', !enabled)
		}, enabled ? 'Выключить логирование' : 'Включить логирование');

		var refreshBtn = E('button', {
			'class': 'cbi-button',
			'click': ui.createHandlerFn(this, 'handleRefresh')
		}, 'Обновить');

		var logBox = E('pre', {
			'id': 'zr-log-output',
			'style': 'margin-top:14px;padding:12px;background:#111;color:#ddd;border-radius:4px;min-height:200px;white-space:pre-wrap;font-size:11.5px;max-height:520px;overflow:auto;'
		}, 'Нажми «Обновить», чтобы загрузить лог.');

		this.logBox = logBox;

		var container = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Логи'),
			E('p', { 'class': 'cbi-value-description', 'id': 'zr-log-status' },
				'Логирование сейчас: ' + (enabled ? 'включено' : 'выключено')),
			E('p', { 'class': 'cbi-value-description' },
				'Файл лога лежит в /tmp — это оперативная память роутера, а не флешка/файловая система: он не занимает постоянное место на устройстве ' +
				'и полностью пропадает при перезагрузке. Но пока роутер работает, лог может расти без ограничения, если оставить логирование включённым ' +
				'надолго — это ест именно ОЗУ, а не "место на роутере" в привычном смысле, но тоже стоит выключать после диагностики, а не держать постоянно.'),
			E('div', { 'style': 'display:flex;gap:8px;margin-bottom:6px;' }, [ toggleBtn, refreshBtn ]),
			E('p', { 'id': 'zr-log-size', 'class': 'cbi-value-description', 'style': 'margin-bottom:6px;' }, ''),
			logBox
		]);

		return container;
	},

	handleToggle: function (newState) {
		uci.set('zapret2', 'config', 'DAEMON_LOG_ENABLE', newState ? '1' : '0');
		uci.save()
			.then(function () { return fs.exec(env_tools.syncCfgPath, []); })
			.then(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); })
			.then(function () {
				ui.addNotification(null, E('p', {}, 'Готово, перезагрузи страницу, чтобы увидеть новое состояние кнопки.'), 'info');
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	handleRefresh: function () {
		var box = this.logBox;
		box.textContent = 'Загрузка...';
		var sizeEl = document.getElementById('zr-log-size');
		fs.exec('/bin/busybox', [ 'sh', '-c', 'du -sh /tmp/zapret2+*.log 2>/dev/null | tail -n 1' ])
			.then(function (res) {
				var sizeText = ((res && res.stdout) || '').trim();
				if (sizeEl) sizeEl.textContent = sizeText ? ('Текущий размер файла лога: ' + sizeText.split(/\s+/)[0]) : '';
			})
			.catch(function () {});
		fs.exec('/bin/busybox', [ 'sh', '-c', 'cat /tmp/zapret2+*.log 2>/dev/null | tail -n 300' ])
			.then(function (res) {
				var text = (res && res.stdout) || '';
				box.textContent = text.trim().length ? text : '(лог пуст или файл ещё не создан — включи логирование и подожди немного трафика)';
			})
			.catch(function (err) {
				box.textContent = 'Ошибка: ' + err;
			});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
