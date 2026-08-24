#!/bin/sh
# Run this ON THE ROUTER, from inside the copied ZapretRemix directory
# (e.g. after scp'ing the whole folder over). Copies files into place,
# reloads rpcd so the new ACL takes effect, and clears LuCI's cache.
set -e
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing ZapretRemix from $SRC_DIR ..."

cp -v "$SRC_DIR/usr/share/luci/menu.d/luci-app-zapretremix.json" /usr/share/luci/menu.d/
cp -v "$SRC_DIR/usr/share/rpcd/acl.d/luci-app-zapretremix.json" /usr/share/rpcd/acl.d/

mkdir -p /www/luci-static/resources/view/zapretremix
cp -v "$SRC_DIR"/www/luci-static/resources/view/zapretremix/*.js /www/luci-static/resources/view/zapretremix/

mkdir -p /opt/zapretremix
cp -v "$SRC_DIR"/opt/zapretremix/*.sh /opt/zapretremix/
chmod +x /opt/zapretremix/*.sh

if [ ! -f /opt/zapretremix/dns-pool.txt ]; then
	cp -v "$SRC_DIR/opt/zapretremix/dns-pool.txt.default" /opt/zapretremix/dns-pool.txt
else
	echo "dns-pool.txt already exists, leaving your edits alone."
fi

echo "Reloading rpcd (ACL) ..."
/etc/init.d/rpcd restart

echo "Clearing LuCI cache ..."
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache* 2>/dev/null || true

echo ""
echo "Done. Open LuCI -> Services -> ZapretRemix (hard-refresh the browser first, Ctrl+Shift+R / Cmd+Shift+R)."
