#!/bin/sh
# ZapretRemix: temporarily test a blind port-scoped strategy (SOCKS5/HTTP
# proxy or any other non-HTTP/TLS/QUIC protocol) against one TCP port, then
# restore. Usage:
#   test-strategy-port.sh backup           — save current NFQWS2_OPT + NFQWS2_PORTS_TCP
#   test-strategy-port.sh apply <port>     — add <port> to the queued port list,
#                                             set NFQWS2_OPT from port-test-opt.txt, sync, restart
#   test-strategy-port.sh restore          — restore both backed-up values, sync, restart, cleanup
#
# Unlike domain pins (which only ever touch NFQWS2_OPT, since 80/443 are
# already queued by default), a SOCKS5/HTTP proxy is usually on some other
# port that nothing queues to nfqws2 in the first place — NFQWS2_OPT's
# --filter-tcp=PORT is irrelevant if that port's packets never reach nfqws2
# at all. So this script ALSO temporarily appends the port to
# NFQWS2_PORTS_TCP for the duration of the test. This is safe specifically
# because it's a full snapshot-and-restore of the exact prior value within
# one script run — no accumulation risk. Permanent pinning (see
# proxyports.js) deliberately does NOT automate this part: NFQWS2_PORTS_TCP
# is also directly user-editable on the Стратегии tab, and merging into a
# value someone else might independently edit is a real drift trap, not
# worth it for a one-time manual step.

set -e
ACTION="$1"
BACKUP_OPT=/opt/zapretremix/portopt-backup.txt
BACKUP_PORTS=/opt/zapretremix/portlist-backup.txt
# Deliberately a different filename from test-strategy.sh's TESTOPT
# (test-opt.txt) — that one's used by the domain-based strategy test in
# Рекомендации. If both tests ever ran around the same time (two browser
# tabs), sharing one file would let them clobber each other's in-flight
# test content mid-loop.
TESTOPT=/opt/zapretremix/port-test-opt.txt

case "$ACTION" in
	backup)
		uci get zapret2.config.NFQWS2_OPT > "$BACKUP_OPT"
		(uci get zapret2.config.NFQWS2_PORTS_TCP 2>/dev/null || echo "80,443") > "$BACKUP_PORTS"
		;;
	apply)
		PORT="$2"
		if [ -z "$PORT" ]; then
			echo "usage: test-strategy-port.sh apply <port>" >&2
			exit 1
		fi
		CUR_PORTS="$(cat "$BACKUP_PORTS")"
		case ",$CUR_PORTS," in
			*",$PORT,"*) NEW_PORTS="$CUR_PORTS" ;;
			*) NEW_PORTS="$CUR_PORTS,$PORT" ;;
		esac
		uci set zapret2.config.NFQWS2_PORTS_TCP="$NEW_PORTS"
		uci set zapret2.config.NFQWS2_OPT="$(cat "$TESTOPT")"
		uci commit zapret2
		/opt/zapret2/sync_config.sh
		/etc/init.d/zapret2 restart
		;;
	restore)
		if [ -f "$BACKUP_OPT" ]; then
			uci set zapret2.config.NFQWS2_OPT="$(cat "$BACKUP_OPT")"
			uci set zapret2.config.NFQWS2_PORTS_TCP="$(cat "$BACKUP_PORTS")"
			uci commit zapret2
			/opt/zapret2/sync_config.sh
			/etc/init.d/zapret2 restart
			rm -f "$BACKUP_OPT" "$BACKUP_PORTS" "$TESTOPT"
		fi
		;;
	*)
		echo "usage: test-strategy-port.sh backup|apply <port>|restore" >&2
		exit 1
		;;
esac
