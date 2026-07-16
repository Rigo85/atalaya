#!/usr/bin/env python3
"""Emite correlaciones Navidrome recientes sin tokens ni titulos; retención RAM 15 min."""

import datetime as dt
import fcntl
import ipaddress
import json
from pathlib import Path


LOG_PATH = Path("/dev/shm/atalaya-navidrome-clients.json")
MAX_AGE_SECONDS = 15 * 60
MAX_LINES = 2000


def safe_text(value, limit):
    return value if isinstance(value, str) and 0 < len(value) <= limit else None


def parse(line, now):
    try:
        value = json.loads(line)
        timestamp = float(value["ts"])
        ip = ipaddress.ip_address(value["ip"])
        user = safe_text(value.get("user"), 64)
        media_id = safe_text(value.get("mediaId"), 96)
        if not user or not media_id or now - timestamp > MAX_AGE_SECONDS or timestamp > now + 60:
            return None
        return {
            "user": user,
            "mediaId": media_id,
            "ip": str(ip),
            "seenAt": dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "timestamp": timestamp,
        }
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def main():
    if not LOG_PATH.exists():
        print("[]")
        return
    now = dt.datetime.now(dt.timezone.utc).timestamp()
    with LOG_PATH.open("r+", encoding="utf8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        lines = handle.readlines()[-MAX_LINES:]
        records = [record for line in lines if (record := parse(line, now))]
        retained = [json.dumps({
            "ts": record["timestamp"], "ip": record["ip"], "user": record["user"], "mediaId": record["mediaId"],
        }, separators=(",", ":")) + "\n" for record in records]
        handle.seek(0)
        handle.truncate()
        handle.writelines(retained)
        handle.flush()

    latest = {}
    for record in records:
        key = (record["user"], record["mediaId"])
        if key not in latest or record["timestamp"] > latest[key]["timestamp"]:
            latest[key] = record
    result = [{key: value for key, value in record.items() if key != "timestamp"}
              for record in sorted(latest.values(), key=lambda item: item["timestamp"], reverse=True)]
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
