#!/bin/sh
set -eu

case "${SSH_ORIGINAL_COMMAND:-}" in
  host)
    exec /usr/local/sbin/atalaya-vps-host-snapshot
    ;;
  egress)
    exec /usr/local/sbin/atalaya-vps-egress
    ;;
  navidrome-clients)
    exec sudo -n /usr/local/sbin/atalaya-vps-navidrome-clients
    ;;
  *)
    echo "comando no permitido" >&2
    exit 64
    ;;
esac
