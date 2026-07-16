#!/usr/bin/env python3
import json
import subprocess


def run_json(args):
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    try:
        return json.loads(result.stdout), result.returncode
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"salida JSON invalida de {args[0]}") from exc


def raw_attribute(table, names):
    for item in table:
        if item.get("name") in names:
            value = item.get("raw", {}).get("value", 0)
            try:
                return int(value)
            except (TypeError, ValueError):
                return 0
    return 0


scan, _ = run_json(["smartctl", "--scan-open", "-j"])
disks = []
for device in scan.get("devices", []):
    args = ["smartctl", "-n", "standby,0", "-a", "-j"]
    if device.get("type"):
        args.extend(["-d", device["type"]])
    args.append(device["name"])
    data, exit_status = run_json(args)
    if str(data.get("power_mode", "")).lower() in {"standby", "sleep"}:
        continue
    table = data.get("ata_smart_attributes", {}).get("table", [])
    passed = data.get("smart_status", {}).get("passed")
    if passed is None:
        passed = not bool(exit_status & 8)
    disks.append({
        "id": data.get("serial_number") or device["name"],
        "passed": bool(passed),
        "temperatureC": data.get("temperature", {}).get("current"),
        "reallocated": raw_attribute(table, {"Reallocated_Sector_Ct", "Reallocated_Event_Count"}),
        "pending": raw_attribute(table, {"Current_Pending_Sector"}),
        "offlineUncorrectable": raw_attribute(table, {"Offline_Uncorrectable"}),
        "crcErrors": raw_attribute(table, {"UDMA_CRC_Error_Count"}),
    })

pools = []
result = subprocess.run(
    ["zpool", "list", "-H", "-o", "name,health"],
    text=True,
    capture_output=True,
    check=False,
)
if result.returncode == 0:
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 2:
            pools.append({"name": fields[0], "health": fields[1]})

print(json.dumps({"disks": disks, "pools": pools}, separators=(",", ":")))
