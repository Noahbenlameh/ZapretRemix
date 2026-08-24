'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require uci';
'require view.zapret2.env as env_tools';

return view.extend({
	load: function () {
		return uci.load('dhcp');
	},

	render: function () {
		var startBtn = E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': ui.createHandlerFn(this, 'handleStart')
		}, '1. Начать захват DNS');

		var stopBtn = E('button', {
			'class': 'cbi-button',
			'click': ui.createHandlerFn(this, 'handleStop')
		}, '2. Остановить и показать домены');

		var resultBox = E('div', { 'id': 'zr-af-results', 'style': 'margin-top:16px;' });
		this.resultBox = resultBox;

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'ZapretRemix — Поиск по приложению'),
			E('p', { 'class': 'cbi-value-description' },
				'Не знаешь, какой домен использует приложение? 1) Нажми «Начать захват», 2) открой и попользуйся приложением на телефоне ' +
				'(особенно момент, где оно ломается), 3) вернись сюда и нажми «Остановить и показать» — увидишь список доменов, ' +
				'которые за это время резолвили устройства в сети, и сможешь одним кликом добавить нужные в «Ресурсы».'),
			E('div', { 'style': 'display:flex;gap:8px;margin-bottom:10px;' }, [ startBtn, stopBtn ]),
			resultBox
		]);
	},

	handleStart: function () {
		uci.set('dhcp', '@dnsmasq[0]', 'logqueries', '1');
		uci.save()
			.then(function () { return fs.exec('/etc/init.d/dnsmasq', [ 'restart' ]); })
			.then(L.bind(function () {
				// clear the resolver's ring buffer view by noting current time; we just re-read logread fresh on stop
				this.resultBox.innerHTML = '';
				this.resultBox.appendChild(E('p', {}, 'Захват идёт. Пользуйся приложением, потом нажми «Остановить и показать».'));
				ui.addNotification(null, E('p', {}, 'Захват DNS запущен.'), 'info');
			}, this))
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	handleStop: function () {
		this.resultBox.innerHTML = '';
		this.resultBox.appendChild(E('p', {}, 'Читаю лог...'));

		fs.exec('/bin/busybox', [ 'sh', '-c', 'logread | grep -i query' ])
			.then(L.bind(function (res) {
				var text = (res && res.stdout) || '';
				var lines = text.split('\n');
				var found = {};
				var re = /query\[\w+\]\s+(\S+)\s+from/;
				lines.forEach(function (line) {
					var m = re.exec(line);
					if (m) found[m[1]] = true;
				});
				var domains = Object.keys(found).sort();
				this.showResults(domains);

				// reload uci state first — the earlier Start click already did a
				// set()+save() on this same section, and stale client-side state
				// can make a second set() on an anonymous section silently miss.
				return uci.load('dhcp');
			}, this))
			.then(function () {
				// turn logging back off — was only needed temporarily
				uci.set('dhcp', '@dnsmasq[0]', 'logqueries', '0');
				return uci.save();
			})
			.then(function () { return fs.exec('/etc/init.d/dnsmasq', [ 'restart' ]); })
			.catch(L.bind(function (err) {
				this.resultBox.innerHTML = '';
				this.resultBox.appendChild(E('p', {}, 'Ошибка: ' + err));
			}, this));
	},

	showResults: function (domains) {
		this.resultBox.innerHTML = '';
		if (!domains.length) {
			this.resultBox.appendChild(E('p', {}, 'Ничего не найдено — DNS-запросов за это время не было записано.'));
			return;
		}
		this.resultBox.appendChild(E('p', {}, 'Найдено доменов: ' + domains.length + '. Отметь нужные и добавь в список ресурсов:'));
		var list = E('div', {}, domains.map(function (d) {
			var checkbox = E('input', { 'type': 'checkbox', 'value': d });
			var row = E('label', { 'style': 'display:flex;align-items:center;gap:8px;padding:3px 0;font-family:monospace;font-size:12.5px;' }, [
				checkbox, d
			]);
			row._checkbox = checkbox;
			return row;
		}));
		this.resultBox.appendChild(list);
		this.resultBox.appendChild(E('button', {
			'class': 'cbi-button cbi-button-apply',
			'style': 'margin-top:12px;',
			'click': ui.createHandlerFn(this, 'handleAddSelected', list)
		}, 'Добавить выбранные в «Ресурсы»'));
	},

	handleAddSelected: function (list) {
		var selected = [];
		list.childNodes.forEach(function (row) {
			if (row._checkbox && row._checkbox.checked) selected.push(row._checkbox.value);
		});
		if (!selected.length) return;

		fs.read(env_tools.hostsUserFN).catch(function () { return ''; }).then(L.bind(function (text) {
			var existing = (text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
			selected.forEach(function (d) {
				if (existing.indexOf(d) === -1) existing.push(d);
			});
			return fs.write(env_tools.hostsUserFN, existing.join('\n') + '\n');
		}, this))
			.then(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); })
			.then(L.bind(function () {
				ui.addNotification(null, E('p', {}, 'Добавлено ' + selected.length + ' домен(ов) в ресурсы.'), 'info');
			}, this))
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
			});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
