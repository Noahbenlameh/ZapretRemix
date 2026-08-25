'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// --blob=NAME:... declarations are global to the whole nfqws2 invocation, not
// scoped to one --new block — a repeated name (base preset vs. a pin using
// the same preset, or two pins sharing one) silently crashes the daemon.
// rebuild-opt.sh strips repeats via a small inline awk program; this pulls
// that program straight out of the script (instead of re-typing a copy here)
// so the test breaks the moment the real logic changes shape, rather than
// quietly testing a stale copy.
function extractDedupAwkProgram() {
	const scriptPath = path.join(__dirname, '..', 'opt/zapretremix/rebuild-opt.sh');
	const src = fs.readFileSync(scriptPath, 'utf8');
	const m = /awk -v existing="\$EXISTING_BLOBS" '([\s\S]*?)'\)"/.exec(src);
	assert.ok(m, 'could not find the blob-dedup awk program in rebuild-opt.sh — did it move or change shape?');
	return m[1];
}

function runDedup(existingBlobsText, extraFileText) {
	const program = extractDedupAwkProgram();
	return execFileSync('awk', [ '-v', 'existing=' + existingBlobsText, program ], {
		input: extraFileText,
		encoding: 'utf8'
	});
}

test('drops a --blob= line whose name already exists in the base config', () => {
	const out = runDedup('--blob=fake_default_tls', '--new\n--blob=fake_default_tls\n--filter-tcp=443\n');
	assert.equal((out.match(/--blob=fake_default_tls/g) || []).length, 0);
	assert.match(out, /--filter-tcp=443/);
});

test('keeps a --blob= line whose name is new', () => {
	const out = runDedup('', '--blob=blob_a:@/path/a.bin\n--filter-tcp=443\n');
	assert.match(out, /--blob=blob_a/);
});

test('dedupes a name repeated within the extra content itself, not just against the base', () => {
	const out = runDedup('', '--blob=dup:@/a\n--filter-tcp=1\n--blob=dup:@/a\n--filter-tcp=2\n');
	assert.equal((out.match(/--blob=dup/g) || []).length, 1);
});

test('leaves lines with no --blob= declaration untouched', () => {
	const out = runDedup('--blob=x', '--filter-tcp=80\n--lua-desync=fake:blob=x:tcp_md5\n');
	assert.match(out, /--filter-tcp=80/);
	assert.match(out, /--lua-desync=fake:blob=x:tcp_md5/);
});
