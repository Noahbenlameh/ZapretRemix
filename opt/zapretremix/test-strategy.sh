#!/bin/sh
# ZapretRemix: temporarily swap NFQWS2_OPT to test one strategy against one
# domain, then restore. Usage:
#   test-strategy.sh backup            — save current NFQWS2_OPT
#   test-strategy.sh apply             — set NFQWS2_OPT from test-opt.txt, sync, restart
#   test-strategy.sh restore           — restore the backed-up NFQWS2_OPT, sync, restart, cleanup
# All via plain `uci` CLI, not LuCI's client-side uci.js — see rebuild-opt.sh
# for why (client-side read-back of a value another process just wrote was
# unreliable in practice on this router).

set -e
ACTION="$1"
BACKUP=/opt/zapretremix/opt-backup.txt
TESTOPT=/opt/zapretremix/test-opt.txt

case "$ACTION" in
	backup)
		uci get zapret2.config.NFQWS2_OPT > "$BACKUP"
		;;
	apply)
		uci set zapret2.config.NFQWS2_OPT="$(cat "$TESTOPT")"
		uci commit zapret2
		/opt/zapret2/sync_config.sh
		/etc/init.d/zapret2 restart
		;;
	restore)
		if [ -f "$BACKUP" ]; then
			uci set zapret2.config.NFQWS2_OPT="$(cat "$BACKUP")"
			uci commit zapret2
			/opt/zapret2/sync_config.sh
			/etc/init.d/zapret2 restart
			rm -f "$BACKUP" "$TESTOPT"
		fi
		;;
	*)
		echo "usage: test-strategy.sh backup|apply|restore" >&2
		exit 1
		;;
esac
