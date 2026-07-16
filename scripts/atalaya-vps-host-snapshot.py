#!/usr/bin/env python3
import json
import os
import subprocess
import time


def read_key_values(path):
    values = {}
    with open(path, encoding="ascii") as handle:
        for line in handle:
            fields = line.replace(":", "").split()
            if len(fields) >= 2:
                try:
                    values[fields[0]] = int(fields[1])
                except ValueError:
                    pass
    return values


def cpu_counters():
    with open("/proc/stat", encoding="ascii") as handle:
        fields = [int(value) for value in handle.readline().split()[1:]]
    return {"total": sum(fields), "idle": fields[3], "iowait": fields[4]}


def vm_counters():
    values = read_key_values("/proc/vmstat")
    return values.get("pswpin", 0) + values.get("pswpout", 0)


cpu_a = cpu_counters()
vm_a = vm_counters()
started = time.monotonic()
time.sleep(0.25)
cpu_b = cpu_counters()
vm_b = vm_counters()
elapsed = max(0.001, time.monotonic() - started)
total = max(1, cpu_b["total"] - cpu_a["total"])
idle = cpu_b["idle"] - cpu_a["idle"]
iowait = cpu_b["iowait"] - cpu_a["iowait"]

memory = read_key_values("/proc/meminfo")
memory_total = memory["MemTotal"]
memory_available = memory["MemAvailable"]
swap_used = max(0, memory.get("SwapTotal", 0) - memory.get("SwapFree", 0)) * 1024

root = os.statvfs("/")
used = (root.f_blocks - root.f_bfree) * root.f_frsize
free = root.f_bavail * root.f_frsize
inode_used = root.f_files - root.f_ffree
root_options = ""
with open("/proc/mounts", encoding="utf8") as handle:
    for line in handle:
        fields = line.split()
        if len(fields) >= 4 and fields[1] == "/":
            root_options = fields[3]
            break


def active(unit):
    result = subprocess.run(["systemctl", "is-active", "--quiet", unit], check=False)
    return result.returncode == 0


clock = subprocess.run(
    ["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
    text=True,
    capture_output=True,
    check=False,
)
wireguard_present = os.path.exists("/sys/class/net/wg0")
handshake_age = None
if wireguard_present:
    handshake = subprocess.run(
        ["sudo", "-n", "/usr/local/sbin/atalaya-vps-wg-handshake"],
        text=True,
        capture_output=True,
        check=True,
    )
    latest = int(handshake.stdout.strip() or "0")
    handshake_age = max(0, int(time.time()) - latest) if latest else None

with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as handle:
    boot_id = handle.read().strip()

snapshot = {
    "bootId": boot_id,
    "cpuPct": max(0, (total - idle - iowait) / total * 100),
    "ioWaitPct": max(0, iowait / total * 100),
    "memoryAvailablePct": memory_available / memory_total * 100,
    "swapUsedBytes": swap_used,
    "swapPagesPerSecond": max(0, (vm_b - vm_a) / elapsed),
    "temperatureC": None,
    "clockSynchronized": clock.stdout.strip() == "yes" if clock.returncode == 0 else None,
    "filesystems": [{
        "path": "/",
        "present": True,
        "readOnly": "ro" in root_options.split(","),
        "usedPct": used / (used + free) * 100 if used + free else 0,
        "freeBytes": free,
        "inodeUsedPct": inode_used / (inode_used + root.f_ffree) * 100 if root.f_files else None,
    }],
    "services": {
        "nginxActive": active("nginx.service"),
        "certbotTimerActive": active("certbot.timer"),
        "wireguardPresent": wireguard_present,
        "wireguardHandshakeAgeS": handshake_age,
    },
}
print(json.dumps(snapshot, separators=(",", ":")))
