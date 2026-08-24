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

# set_cfg_nfqws_strat (below) is meant to (re)build NFQWS2_OPT for the given
# preset, but as a side effect it also resets MODE_FILTER (confirmed:
# zapret2.config.MODE_FILTER silently reverted from 'autohostlist' back to
# 'hostlist' after nothing more than adding pins in Закреплённые, which
# calls this script on every add/remove) — and possibly the packet-depth
# fields alongside it, same family of Dashboard setting. Since this script
# re-runs on every single pin change, that silently downgrades the whole
# household's filtering mode far more often than the user would ever
# expect from "I added one pin." Snapshot these before the preset call and
# put them back right after, so rebuilding pin blocks never has the side
# effect of changing what Дашборд already has set.
SAVED_MODE_FILTER="$(uci get zapret2.config.MODE_FILTER 2>/dev/null || true)"
SAVED_TCP_OUT="$(uci get zapret2.config.NFQWS2_TCP_PKT_OUT 2>/dev/null || true)"
SAVED_TCP_IN="$(uci get zapret2.config.NFQWS2_TCP_PKT_IN 2>/dev/null || true)"
SAVED_UDP_OUT="$(uci get zapret2.config.NFQWS2_UDP_PKT_OUT 2>/dev/null || true)"
SAVED_UDP_IN="$(uci get zapret2.config.NFQWS2_UDP_PKT_IN 2>/dev/null || true)"

. /opt/zapret2/def-cfg.sh
set_cfg_nfqws_strat "$PRESET" zapret2

[ -n "$SAVED_MODE_FILTER" ] && uci set zapret2.config.MODE_FILTER="$SAVED_MODE_FILTER"
[ -n "$SAVED_TCP_OUT" ] && uci set zapret2.config.NFQWS2_TCP_PKT_OUT="$SAVED_TCP_OUT"
[ -n "$SAVED_TCP_IN" ] && uci set zapret2.config.NFQWS2_TCP_PKT_IN="$SAVED_TCP_IN"
[ -n "$SAVED_UDP_OUT" ] && uci set zapret2.config.NFQWS2_UDP_PKT_OUT="$SAVED_UDP_OUT"
[ -n "$SAVED_UDP_IN" ] && uci set zapret2.config.NFQWS2_UDP_PKT_IN="$SAVED_UDP_IN"

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
