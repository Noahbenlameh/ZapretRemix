'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// shared.js is a LuCI view module: it ends with a bare top-level
// `return baseclass.extend({...})`, relying on LuCI's own loader to supply
// the `baseclass` global and to capture the return value. A plain
// `require()` won't give us that object back (Node's CommonJS wrapper
// discards a top-level return's value), so we re-wrap the source in our own
// function and hand it a minimal `baseclass` stand-in — `.extend()` just
// returns the plain object, which is all these tests need.
function loadShared() {
	const filePath = path.join(__dirname, '..', 'www/luci-static/resources/view/zapretremix/shared.js');
	const code = fs.readFileSync(filePath, 'utf8');
	const wrapped = '(function (baseclass) {\n' + code + '\n})';
	const fn = vm.runInThisContext(wrapped, { filename: filePath });
	return fn({ extend: function (obj) { return obj; } });
}

const shared = loadShared();

test('safeName replaces unsafe characters, leaves domain-safe ones alone', () => {
	assert.equal(shared.safeName('exam ple.com'), 'exam_ple.com');
	assert.equal(shared.safeName('a/b:c'), 'a_b_c');
	assert.equal(shared.safeName('normal-domain.co.uk'), 'normal-domain.co.uk');
});

test('fillHostlist replaces both placeholder forms with the same pin file', () => {
	const filled = shared.fillHostlist('<HOSTLIST> ... <HOSTLIST_NOAUTO>', '/opt/zapretremix/pin-hosts/x.txt');
	assert.equal(filled, '--hostlist=/opt/zapretremix/pin-hosts/x.txt ... --hostlist=/opt/zapretremix/pin-hosts/x.txt');
});

test('parseDomains splits on whitespace/commas, dedupes, strips unsafe chars', () => {
	assert.deepEqual(
		shared.parseDomains('example.com, foo.bar\nexample.com   baz<script>.com'),
		[ 'example.com', 'foo.bar', 'bazscript.com' ]
	);
});

test('parseDomains handles empty/undefined input', () => {
	assert.deepEqual(shared.parseDomains(''), []);
	assert.deepEqual(shared.parseDomains(undefined), []);
});

test('normalizePin passes through the current multi-domain shape unchanged', () => {
	const pin = { id: 'yt', domains: [ 'youtube.com', 'googlevideo.com' ], preset: 'default', dns: '1.1.1.1' };
	assert.deepEqual(shared.normalizePin(pin), pin);
});

test('normalizePin upgrades the legacy single-domain shape', () => {
	const legacy = { domain: 'example.com', preset: 'default' };
	const normalized = shared.normalizePin(legacy);
	assert.equal(normalized.id, 'example.com');
	assert.deepEqual(normalized.domains, [ 'example.com' ]);
	assert.equal(normalized.dns, '');
});

test('every PIN_TEMPLATES entry has HTTP/TLS/QUIC hostlist placeholders', () => {
	Object.keys(shared.PIN_TEMPLATES).forEach((key) => {
		const tpl = shared.PIN_TEMPLATES[key];
		assert.match(tpl, /<HOSTLIST>/, key + ' missing <HOSTLIST>');
		assert.match(tpl, /<HOSTLIST_NOAUTO>/, key + ' missing <HOSTLIST_NOAUTO>');
	});
});

test('PRESET_CHOICES and STRATEGY_TITLES stay in sync', () => {
	shared.PRESET_CHOICES.forEach((p) => {
		assert.equal(shared.STRATEGY_TITLES[p.key], p.title);
	});
});

test('every FAMILY_PRESETS entry lists at least 2 domains (the point is multi-domain coverage)', () => {
	Object.keys(shared.FAMILY_PRESETS).forEach((key) => {
		assert.ok(shared.FAMILY_PRESETS[key].domains.length >= 2, key + ' has fewer than 2 domains');
	});
});

test('every PORT_COMBOS entry builds a filter scoped to the given port', () => {
	shared.PORT_COMBOS.forEach((combo) => {
		assert.match(combo.build('1234'), /--filter-tcp=1234/, combo.key + ' did not filter on the given port');
	});
});
