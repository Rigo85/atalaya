#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


metadata_url = "http://169.254.169.254/opc/v2/instance/"
request = urllib.request.Request(metadata_url, headers={"Authorization": "Bearer Oracle"})
with urllib.request.urlopen(request, timeout=5) as response:
    metadata = json.load(response)

instance_id = metadata["id"]
compartment_id = metadata["compartmentId"]
local_tz = ZoneInfo("America/Lima")
now_local = datetime.now(local_tz)
day_start = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
month_start = day_start.replace(day=1)


def iso_utc(value):
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


oci = shutil.which("oci") or os.path.expanduser("~/.local/bin/oci")
if not os.path.exists(oci):
    raise RuntimeError("OCI CLI no instalado")

result = subprocess.run([
    oci,
    "monitoring", "metric-data", "summarize-metrics-data",
    "--auth", "instance_principal",
    "--compartment-id", compartment_id,
    "--namespace", "oci_computeagent",
    "--query-text", f'NetworksBytesOut[1h]{{resourceId = "{instance_id}"}}.rate()',
    "--start-time", iso_utc(month_start),
    "--end-time", iso_utc(now_local),
], text=True, capture_output=True, check=True)
payload = json.loads(result.stdout)

day_bytes = 0.0
month_bytes = 0.0
series = payload.get("data", [])
points = series[0].get("aggregated-datapoints", []) if series else []
for point in points:
    timestamp = datetime.fromisoformat(point["timestamp"].replace("Z", "+00:00")).astimezone(local_tz)
    value = float(point.get("value", 0)) * 3600
    month_bytes += value
    if timestamp.date() == now_local.date():
        day_bytes += value

print(json.dumps({
    "day_bytes": round(day_bytes),
    "month_bytes": round(month_bytes),
    "sampled_at": now_local.isoformat(timespec="seconds"),
}, separators=(",", ":")))
