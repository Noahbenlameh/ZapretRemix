#!/bin/sh
# ZapretRemix: rebuild NFQWS2_OPT = clean global preset + pinned blocks.
# Usage: rebuild-opt.sh <presetKey>
# Extra pin blocks are read from /opt/zapretremix/pin-blocks.txt, written
# by the caller (pins.js / strategies.js) beforehand. Does the whole
# "reset to clean base, then append" as one atomic shell operation using
# plain `uci` CLI commands — avoids relying on LuCI's client-side uci.js
# to read back a value that was just written by a separate shell command,
# which was silently not picking up the fresh value in practice.

set -e
PRESET="$1"
EXTRA_FILE=/opt/zapretremix/pin-blocks.txt

. /opt/zapret2/def-cfg.sh
set_cfg_nfqws_strat "$PRESET" zapret2

if [ -s "$EXTRA_FILE" ]; then
	BASE_OPT="$(uci get zapret2.config.NFQWS2_OPT)"

	# --blob=NAME:... declarations are global to the whole nfqws2 invocation,
	# not scoped to one --new block. If a pin uses the same preset as the
	# global strategy (or two pins share a preset), its template repeats the
	# same --blob= lines the base already has — nfqws2 silently fails to
	# start on a duplicate blob name. Strip any --blob= line here whose name
	# already appeared (in BASE_OPT, or earlier in EXTRA itself).
	EXISTING_BLOBS="$(printf '%s\n' "$BASE_OPT" | grep -o '^--blob=[^:]*' || true)"
	EXTRA="$(cat "$EXTRA_FILE" | awk -v existing="$EXISTING_BLOBS" '
		BEGIN { n = split(existing, arr, "\n"); for (i = 1; i <= n; i++) if (arr[i] != "") seen[arr[i]] = 1 }
		/^--blob=/ { name = $0; sub(/:.*/, "", name); if (seen[name]) next; seen[name] = 1 }
		{ print }
	')"

	uci set zapret2.config.NFQWS2_OPT="${BASE_OPT}

${EXTRA}"
	uci commit zapret2
fi
