#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
version=v24.20.0
archive="node-$version-darwin-arm64.tar.gz"
checksum=40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8
[ "$(uname -sm)" = "Darwin arm64" ] || { echo 'This bundle requires macOS arm64' >&2; exit 1; }
cache="src-tauri/target/node-download"
mkdir -p "$cache" src-tauri/runtime
if [ ! -f "$cache/$archive" ]; then
  curl --fail --location --retry 2 "https://nodejs.org/dist/$version/$archive" -o "$cache/$archive.part"
  mv "$cache/$archive.part" "$cache/$archive"
fi
printf '%s  %s\n' "$checksum" "$cache/$archive" | shasum -a 256 -c -
tar -xzf "$cache/$archive" -C "$cache" "node-$version-darwin-arm64/bin/node" "node-$version-darwin-arm64/LICENSE"
cp "$cache/node-$version-darwin-arm64/bin/node" src-tauri/runtime/node
cp "$cache/node-$version-darwin-arm64/LICENSE" src-tauri/runtime/LICENSE
chmod 755 src-tauri/runtime/node
printf '%s\n' "$version" > src-tauri/runtime/VERSION
