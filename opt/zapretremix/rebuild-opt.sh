#!/bin/sh
# ZapretRemix: rebuild NFQWS2_OPT = clean global preset + pinned domain
# blocks + pinned port blocks.
# Usage: rebuild-opt.sh <presetKey>
# Domain pin blocks come from /opt/zapretremix/pin-blocks.txt (pins.js /
# strategies.js / recommend.js), port pin blocks from
# /opt/zapretremix/pin-ports-blocks.txt (proxyports.js) — both written by
# the caller beforehand. Does the whole "reset to clean base, then append"
# as one atomic shell operation using plain `uci` CLI commands — avoids
# relying on LuCI's client-side uci.js to read back a value that was just
# written by a separate shell command, which was silently not picking up
# the fresh value in practice.
#
# Deliberately does NOT touch NFQWS2_PORTS_TCP (which port pin blocks need
# to actually receive traffic) — that field is also directly user-editable
# on the Стратегии tab, and this script re-runs on every domain/port pin
# change, so accumulating into a value someone else might independently
# edit would drift out of sync fast. proxyports.js instead tells the user
# to add the port there once by hand.

set -e
PRESET="$1"
EXTRA_FILE=/opt/zapretremix/pin-blocks.txt
PORT_EXTRA_FILE=/opt/zapretremix/pin-ports-blocks.txt

. /opt/zapret2/def-cfg.sh
set_cfg_nfqws_strat "$PRESET" zapret2

BASE_OPT="$(uci get zapret2.config.NFQWS2_OPT)"
APPEND=""

if [ -s "$EXTRA_FILE" ]; then
	# --blob=NAME:... declarations are global to the whole nfqws2 invocation,
	# not scoped to one --new block. If a pin uses the same preset as the
	# global strategy (or two pins share a preset), its template repeats the
	# same --blob= lines the base already has — nfqws2 silently fails to
	# start on a duplicate blob name. Strip any --blob= line here whose name
	# already appeared (in BASE_OPT, or earlier in EXTRA itself).
	EXISTING_BLOBS="$(printf '%s\n' "$BASE_OPT" | grep -o -- '--blob=[^:]*' || true)"
	DOMAIN_EXTRA="$(cat "$EXTRA_FILE" | awk -v existing="$EXISTING_BLOBS" '
		BEGIN { n = split(existing, arr, "\n"); for (i = 1; i <= n; i++) if (arr[i] != "") seen[arr[i]] = 1 }
		{
			line = $0
			if (match(line, /--blob=[^:]*/)) {
				name = substr(line, RSTART, RLENGTH)
				if (seen[name]) next
				seen[name] = 1
			}
			print
		}
	')"
	APPEND="${APPEND}

${DOMAIN_EXTRA}"
fi

if [ -s "$PORT_EXTRA_FILE" ]; then
	# Port combos only ever reference the built-in fake_default_tls blob
	# (never declare a custom one), so no dedup needed here.
	APPEND="${APPEND}

$(cat "$PORT_EXTRA_FILE")"
fi

if [ -n "$APPEND" ]; then
	uci set zapret2.config.NFQWS2_OPT="${BASE_OPT}${APPEND}"
fi

uci commit zapret2
