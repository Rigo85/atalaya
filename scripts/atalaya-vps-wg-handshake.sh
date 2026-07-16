#!/bin/sh
set -eu

wg show wg0 latest-handshakes | awk 'BEGIN { latest=0 } { if ($2 > latest) latest=$2 } END { print latest }'
