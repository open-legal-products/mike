#!/usr/bin/env bash
# assets/icon-1024.png → assets/icon.icns using only macOS-native tools.
set -euo pipefail
cd "$(dirname "$0")/../assets"

rm -rf icon.iconset && mkdir icon.iconset
for size in 16 32 128 256 512; do
  sips -z $size $size icon-1024.png --out "icon.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double icon-1024.png --out "icon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset
echo "wrote assets/icon.icns"
