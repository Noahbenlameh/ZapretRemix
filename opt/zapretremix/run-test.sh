#!/bin/sh
# ZapretRemix background test runner — invoked (via setsid, backgrounded)
# from the Test & Analyze tab. Not meant to be launched directly except
# for debugging: `sh /opt/zapretremix/run-test.sh <domain> <0|1-insecure>`
# runs synchronously in the foreground, exactly like the real background
# job does internally — useful to reproduce/debug without going through
# LuCI at all.

DOMAIN="$1"
INSECURE="$2"
OUT=/tmp/zr-test-output.log
ANSWERS=/tmp/zr-test-answers.txt
MARK="###ZRDONE###"

rm -f "$OUT" "$ANSWERS"

{
	echo "2"
	echo "$DOMAIN"
	echo "4"
	echo "N"
	echo "Y"
	echo "N"
	echo "1"
	echo "N"
	echo "1"
	echo ""
} > "$ANSWERS"

{
	/etc/init.d/zapret2 stop
	if [ "$INSECURE" = "1" ]; then
		CURL_OPT="-k" /opt/zapret2/blockcheck2.sh < "$ANSWERS"
	else
		/opt/zapret2/blockcheck2.sh < "$ANSWERS"
	fi
	/etc/init.d/zapret2 start
	echo "$MARK"
} > "$OUT" 2>&1
