'use strict';
'require baseclass';
'require view';
'require fs';
'require ui';
'require uci';
'require view.zapret2.env as env_tools';
'require view.zapretremix.shared as shared';

var PIN_HOSTS_DIR = '/opt/zapretremix/pin-hosts';
var PINS_FILE = '/opt/zapretremix/pins.json';

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
				'которые за это время резолвили устройства в сети.'),
			E('p', { 'class': 'cbi-value-description' },
				'Это и есть способ самому найти "набор" для сервиса, которого нет в готовых списках на Закреплённых/Рекомендациях (там только ' +
				'YouTube/Discord/Instagram/Twitter/Facebook/WhatsApp/Telegram/Netflix/Spotify/Twitch/Steam/LinkedIn) — просто отметь нужные найденные ' +
				'домены и сразу закрепи их одной группой ниже.'),
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
		this.resultBox.appendChild(E('div', { 'style': 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center;' }, [
			E('button', {
				'class': 'cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, 'handleAddSelected', list)
			}, 'Добавить выбранные в «Ресурсы»'),
			E('select', { 'id': 'zr-af-preset', 'style': 'width:200px;' },
				shared.PRESET_CHOICES.map(function (p) { return E('option', { value: p.key }, p.title); })
			),
			E('input', { 'type': 'text', 'id': 'zr-af-dns', 'placeholder': 'DNS необязательно: 8.8.8.8', 'style': 'width:170px;' }),
			E('button', {
				'class': 'cbi-button cbi-button-positive',
				'click': ui.createHandlerFn(this, 'handlePinSelected', list)
			}, 'Закрепить выбранные как группу')
		]));
	},

	// Same shape/flow as pins.js's handleAdd — one entry, several domains,
	// shared strategy + DNS. Lets a family found here go straight into
	// Закреплённые instead of round-tripping through Ресурсы + a manual
	// re-type on that tab.
	handlePinSelected: function (list) {
		var selected = [];
		list.childNodes.forEach(function (row) {
			if (row._checkbox && row._checkbox.checked) selected.push(row._checkbox.value);
		});
		if (!selected.length) {
			ui.addNotification(null, E('p', {}, 'Сначала отметь хотя бы один домен.'), 'error');
			return;
		}

		var preset = document.getElementById('zr-af-preset').value;
		var dns = document.getElementById('zr-af-dns').value.trim();
		var id = shared.safeName(selected[0]);

		fs.read(PINS_FILE).catch(function () { return '[]'; }).then(function (text) {
			var raw;
			try { raw = JSON.parse(text); } catch (e) { raw = []; }
			var pins = raw.map(shared.normalizePin);
			if (pins.some(function (p) { return p.id === id || selected.some(function (d) { return p.domains.indexOf(d) !== -1; }); })) {
				ui.addNotification(null, E('p', {}, 'Один из этих доменов уже закреплён — измени на вкладке «Закреплённые».'), 'warning');
				return null;
			}
			pins.push({ id: id, domains: selected, preset: preset, dns: dns });
			var pinFile = PIN_HOSTS_DIR + '/' + id + '.txt';

			return fs.exec('/bin/busybox', [ 'mkdir', '-p', PIN_HOSTS_DIR ])
				.then(function () { return fs.write(pinFile, selected.join('\n') + '\n'); })
				.then(function () { return fs.write(PINS_FILE, JSON.stringify(pins, null, 2)); })
				.then(function () {
					if (!dns) return null;
					return uci.load('dhcp').then(function () {
						var dlist = uci.get('dhcp', '@dnsmasq[0]', 'server') || [];
						if (!Array.isArray(dlist)) dlist = [ dlist ];
						selected.forEach(function (domain) {
							var entry = '/' + domain + '/' + dns;
							if (dlist.indexOf(entry) === -1) dlist.push(entry);
						});
						uci.set('dhcp', '@dnsmasq[0]', 'server', dlist);
						return uci.save().catch(function () {});
					}).then(function () { return fs.exec('/etc/init.d/dnsmasq', [ 'restart' ]); });
				})
				.then(function () {
					var extra = pins.map(function (pin) {
						var norm = shared.normalizePin(pin);
						var pf = PIN_HOSTS_DIR + '/' + norm.id + '.txt';
						return '--new\n' + shared.fillHostlist(shared.PIN_TEMPLATES[norm.preset] || shared.PIN_TEMPLATES.default, pf);
					}).join('\n\n');
					return fs.write('/opt/zapretremix/pin-blocks.txt', extra);
				})
				.then(function () {
					return fs.exec('/bin/busybox', [ 'sh', '-c', 'grep -o "Strategy__[a-zA-Z_0-9]*" /opt/zapret2/config 2>/dev/null | head -1' ]);
				})
				.then(function (res) {
					var m = /Strategy__(\S+)/.exec((res && res.stdout) || '');
					var globalPreset = (m && shared.PIN_TEMPLATES[m[1]]) ? m[1] : 'default';
					return fs.exec('/opt/zapretremix/rebuild-opt.sh', [ globalPreset ]);
				})
				.then(function () { return fs.exec(env_tools.syncCfgPath, []); })
				.then(function () { return fs.exec(env_tools.execPath, [ 'restart' ]); })
				.then(function () {
					ui.addNotification(null, E('p', {}, selected.join(', ') + ' закреплены как группа.'), 'info');
				});
		}).catch(function (err) {
			ui.addNotification(null, E('p', {}, 'Ошибка: ' + err), 'error');
		});
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
