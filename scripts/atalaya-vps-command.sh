#!/bin/sh
set -eu

case "${SSH_ORIGINAL_COMMAND:-}" in
  host)
    exec /usr/local/sbin/atalaya-vps-host-snapshot
    ;;
  egress)
    exec /usr/local/sbin/atalaya-vps-egress
    ;;
  *)
    echo "comando no permitido" >&2
    exit 64
    ;;
esac
