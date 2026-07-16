#!/usr/bin/env bash
set -euo pipefail

env_file=${ATALAYA_ENV_FILE:-/home/rigo/atalaya/.env}
target_dir=${GEOIP_DIR:-/home/rigo/atalaya-geoip}
database_url=${MAXMIND_GEOIP_DATABASE_URL:-https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz}
checksum_url=${MAXMIND_GEOIP_SHA256_URL:-https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz.sha256}

value() {
  sed -n "s/^$1=//p" "$env_file" | tail -n 1
}

account_id=$(value MAXMIND_ACCOUNT_ID)
license_key=$(value MAXMIND_LICENSE_KEY)
test -n "$account_id"
test -n "$license_key"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
umask 077
install -d -m 700 "$target_dir"

curl -fsSL --retry 3 --connect-timeout 15 -u "$account_id:$license_key" \
  "$database_url" -o "$tmp/geolite.tgz"
curl -fsSL --retry 3 --connect-timeout 15 -u "$account_id:$license_key" \
  "$checksum_url" -o "$tmp/geolite.tgz.sha256"

expected_checksum=$(awk 'NF { print $1; exit }' "$tmp/geolite.tgz.sha256")
test "${#expected_checksum}" -eq 64
printf '%s  %s\n' "$expected_checksum" "$tmp/geolite.tgz" | sha256sum -c - >/dev/null

tar -xzf "$tmp/geolite.tgz" -C "$tmp"
database=$(find "$tmp" -type f -name GeoLite2-City.mmdb -print -quit)
test -n "$database"
test -s "$database"

install -m 600 "$database" "$target_dir/GeoLite2-City.mmdb.tmp"
mv -f "$target_dir/GeoLite2-City.mmdb.tmp" "$target_dir/GeoLite2-City.mmdb"
