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
	EXTRA="$(cat "$EXTRA_FILE")"
	uci set zapret2.config.NFQWS2_OPT="${BASE_OPT}

${EXTRA}"
	uci commit zapret2
fi
