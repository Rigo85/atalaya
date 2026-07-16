import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { HealthRegistry, AdapterName } from '../health.js';
import type { IncidentManager, IncidentSeverity } from '../incidents.js';
import type { StateStore } from '../state.js';

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;

export interface FilesystemSnapshot {
  path: string;
  present: boolean;
  readOnly: boolean;
  usedPct: number;
  freeBytes: number;
  inodeUsedPct: number | null;
}

export interface HostSnapshot {
  bootId: string;
  cpuPct: number | null;
  ioWaitPct: number | null;
  memoryAvailablePct: number;
  swapUsedBytes: number;
  swapPagesPerSecond: number;
  temperatureC: number | null;
  clockSynchronized: boolean | null;
  filesystems: FilesystemSnapshot[];
  services?: {
    nginxActive?: boolean;
    certbotTimerActive?: boolean;
    wireguardPresent?: boolean;
    wireguardHandshakeAgeS?: number | null;
  };
}

export interface HostThresholds {
  systemDiskWarningPct: number;
  systemDiskCriticalPct: number;
  mediaDiskWarningPct: number;
  mediaDiskCriticalPct: number;
  mediaDiskCriticalFreeBytes: number;
  inodeWarningPct: number;
  inodeCriticalPct: number;
  memoryWarningAvailablePct: number;
  memoryCriticalAvailablePct: number;
  cpuWarningPct: number;
  cpuCriticalPct: number;
  ioWaitWarningPct: number;
  ioWaitCriticalPct: number;
  temperatureWarningC: number;
  temperatureCriticalC: number;
}

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

interface SustainedCondition {
  warningSince: number | null;
  criticalSince: number | null;
}

export type SnapshotCollector = () => Promise<HostSnapshot>;

export class HostMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private failures = 0;
  private sustained = new Map<string, SustainedCondition>();

  constructor(
    private hostName: string,
    private adapterName: AdapterName,
    private collector: SnapshotCollector,
    private systemMounts: Set<string>,
    private mediaMounts: Set<string>,
    private thresholds: HostThresholds,
    private intervalMs: number,
    private incidents: IncidentManager,
    private state: StateStore,
    private health: HealthRegistry,
    private log: Logger,
    private now: () => number = Date.now,
  ) {
    health.register(adapterName);
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const snapshot = await this.collector();
      this.failures = 0;
      this.health.connected(this.adapterName);
      await this.incidents.observe({
        key: `${this.hostName}.monitor`, severity: 'ok', message: `${this.hostName} monitor operativo`,
      });
      await this.evaluate(snapshot);
    } catch (err) {
      this.failures++;
      this.health.disconnected(this.adapterName, String(err));
      this.log.warn({ host: this.hostName, failures: this.failures, err: String(err) }, 'host check falló');
      if (this.failures >= 3) {
        await this.incidents.observe({
          key: `${this.hostName}.monitor`,
          severity: 'critical',
          message: `HOST ${this.hostName}: monitor inaccesible (${this.failures} fallos)`,
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async evaluate(snapshot: HostSnapshot): Promise<void> {
    const previousBootId = this.state.getLastBootId(this.hostName);
    if (!previousBootId) this.state.setLastBootId(this.hostName, snapshot.bootId);
    else if (previousBootId !== snapshot.bootId) {
      this.state.setLastBootId(this.hostName, snapshot.bootId);
      await this.incidents.observe({
        key: `${this.hostName}.reboot`, severity: 'warning',
        message: `HOST ${this.hostName}: reinicio detectado`,
      });
    } else {
      await this.incidents.observe({
        key: `${this.hostName}.reboot`, severity: 'ok', message: `${this.hostName} estable`,
      });
    }

    await this.observeSustained(
      `${this.hostName}.memory`,
      snapshot.memoryAvailablePct <= this.thresholds.memoryWarningAvailablePct,
      snapshot.memoryAvailablePct <= this.thresholds.memoryCriticalAvailablePct,
      10 * 60_000,
      5 * 60_000,
      `HOST ${this.hostName}: RAM disponible ${snapshot.memoryAvailablePct.toFixed(1)}%, swap ${formatGiB(snapshot.swapUsedBytes)}, pag ${snapshot.swapPagesPerSecond.toFixed(1)} p/s`,
    );
    if (snapshot.cpuPct !== null) {
      await this.observeSustained(
        `${this.hostName}.cpu`,
        snapshot.cpuPct >= this.thresholds.cpuWarningPct,
        snapshot.cpuPct >= this.thresholds.cpuCriticalPct,
        10 * 60_000,
        5 * 60_000,
        `HOST ${this.hostName}: CPU ${snapshot.cpuPct.toFixed(1)}%`,
      );
    }
    if (snapshot.ioWaitPct !== null) {
      await this.observeSustained(
        `${this.hostName}.iowait`,
        snapshot.ioWaitPct >= this.thresholds.ioWaitWarningPct,
        snapshot.ioWaitPct >= this.thresholds.ioWaitCriticalPct,
        15 * 60_000,
        10 * 60_000,
        `HOST ${this.hostName}: iowait ${snapshot.ioWaitPct.toFixed(1)}%`,
      );
    }
    if (snapshot.temperatureC !== null) {
      await this.observeSustained(
        `${this.hostName}.temperature`,
        snapshot.temperatureC >= this.thresholds.temperatureWarningC,
        snapshot.temperatureC >= this.thresholds.temperatureCriticalC,
        5 * 60_000,
        2 * 60_000,
        `HOST ${this.hostName}: CPU ${snapshot.temperatureC.toFixed(1)}C`,
      );
    }
    if (snapshot.clockSynchronized !== null) {
      await this.observeSustained(
        `${this.hostName}.clock`, !snapshot.clockSynchronized, false, 5 * 60_000, Infinity,
        `HOST ${this.hostName}: reloj no sincronizado`,
      );
    }

    for (const fs of snapshot.filesystems) await this.evaluateFilesystem(fs);
    if (snapshot.services) await this.evaluateServices(snapshot.services);
  }

  private async evaluateFilesystem(fs: FilesystemSnapshot): Promise<void> {
    const id = pathId(fs.path);
    if (!fs.present) {
      await this.incidents.observe({
        key: `${this.hostName}.mount.${id}`, severity: 'critical',
        message: `HOST ${this.hostName}: montaje ausente ${fs.path}`,
      });
      return;
    }
    await this.incidents.observe({
      key: `${this.hostName}.mount.${id}`, severity: 'ok', message: `${fs.path} montado`,
    });
    await this.incidents.observe({
      key: `${this.hostName}.readonly.${id}`,
      severity: fs.readOnly ? 'critical' : 'ok',
      message: fs.readOnly
        ? `HOST ${this.hostName}: ${fs.path} en solo lectura`
        : `${fs.path} lectura/escritura`,
    });

    const media = this.mediaMounts.has(fs.path);
    const warningPct = media ? this.thresholds.mediaDiskWarningPct : this.thresholds.systemDiskWarningPct;
    const criticalPct = media ? this.thresholds.mediaDiskCriticalPct : this.thresholds.systemDiskCriticalPct;
    const critical = fs.usedPct >= criticalPct ||
      (media && fs.freeBytes < this.thresholds.mediaDiskCriticalFreeBytes);
    const severity: IncidentSeverity = critical ? 'critical' : fs.usedPct >= warningPct ? 'warning' : 'ok';
    await this.incidents.observe({
      key: `${this.hostName}.space.${id}`,
      severity,
      message: `HOST ${this.hostName}: ${fs.path} ${fs.usedPct.toFixed(0)}% usado, ${formatGiB(fs.freeBytes)} libres`,
    });

    if (fs.inodeUsedPct !== null) {
      const inodeSeverity: IncidentSeverity = fs.inodeUsedPct >= this.thresholds.inodeCriticalPct
        ? 'critical' : fs.inodeUsedPct >= this.thresholds.inodeWarningPct ? 'warning' : 'ok';
      await this.incidents.observe({
        key: `${this.hostName}.inodes.${id}`,
        severity: inodeSeverity,
        message: `HOST ${this.hostName}: inodos ${fs.path} ${fs.inodeUsedPct.toFixed(0)}%`,
      });
    }
  }

  private async evaluateServices(services: NonNullable<HostSnapshot['services']>): Promise<void> {
    if (services.nginxActive !== undefined) {
      await this.incidents.observe({
        key: `${this.hostName}.nginx`, severity: services.nginxActive ? 'ok' : 'critical',
        message: services.nginxActive ? 'VPS nginx operativo' : 'VPS: nginx no está activo',
      });
    }
    if (services.certbotTimerActive !== undefined) {
      await this.incidents.observe({
        key: `${this.hostName}.certbot`, severity: services.certbotTimerActive ? 'ok' : 'warning',
        message: services.certbotTimerActive ? 'VPS certbot timer activo' : 'VPS: certbot timer inactivo',
      });
    }
    if (services.wireguardPresent !== undefined) {
      await this.incidents.observe({
        key: `${this.hostName}.wireguard`, severity: services.wireguardPresent ? 'ok' : 'critical',
        message: services.wireguardPresent ? 'VPS WireGuard presente' : 'VPS: interfaz WireGuard ausente',
      });
    }
    const age = services.wireguardHandshakeAgeS;
    if (services.wireguardPresent && age === null) {
      await this.incidents.observe({
        key: `${this.hostName}.wireguard-handshake`,
        severity: 'critical',
        message: 'VPS: WireGuard sin handshake registrado',
      });
    } else if (age !== undefined && age !== null) {
      await this.incidents.observe({
        key: `${this.hostName}.wireguard-handshake`,
        severity: age >= 600 ? 'critical' : age >= 180 ? 'warning' : 'ok',
        message: `VPS: ultimo handshake WireGuard hace ${Math.round(age)}s`,
      });
    }
  }

  private async observeSustained(
    key: string,
    warning: boolean,
    critical: boolean,
    warningMs: number,
    criticalMs: number,
    message: string,
  ): Promise<void> {
    const now = this.now();
    const state = this.sustained.get(key) ?? { warningSince: null, criticalSince: null };
    state.warningSince = warning ? state.warningSince ?? now : null;
    state.criticalSince = critical ? state.criticalSince ?? now : null;
    this.sustained.set(key, state);
    const severity: IncidentSeverity = critical && state.criticalSince !== null && now - state.criticalSince >= criticalMs
      ? 'critical'
      : warning && state.warningSince !== null && now - state.warningSince >= warningMs
        ? 'warning' : 'ok';
    if (severity !== 'ok' || (!warning && !critical)) {
      await this.incidents.observe({ key, severity, message });
    }
  }
}

interface CpuCounters { total: number; idle: number; ioWait: number }
interface VmCounters { swapIn: number; swapOut: number }

export class LocalHostCollector {
  private previousCpu?: CpuCounters;
  private previousVm?: VmCounters;
  private previousAt?: number;

  constructor(private mounts: string[], private now: () => number = Date.now) {}

  async collect(): Promise<HostSnapshot> {
    const [bootId, procStat, memInfo, vmStat, filesystems, temperatureC, clockSynchronized] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile('/proc/stat', 'utf8'),
      readFile('/proc/meminfo', 'utf8'),
      readFile('/proc/vmstat', 'utf8'),
      Promise.all(this.mounts.map((path) => filesystemSnapshot(path))),
      readTemperature(),
      readClockSynchronized(),
    ]);
    const cpu = parseCpu(procStat);
    const vm = parseVm(vmStat);
    const memory = parseMemory(memInfo);
    const now = this.now();
    const cpuDelta = this.previousCpu ? cpuPercent(this.previousCpu, cpu) : { cpuPct: null, ioWaitPct: null };
    const seconds = this.previousAt ? Math.max(0.001, (now - this.previousAt) / 1000) : 1;
    const swapPagesPerSecond = this.previousVm
      ? ((vm.swapIn - this.previousVm.swapIn) + (vm.swapOut - this.previousVm.swapOut)) / seconds : 0;
    this.previousCpu = cpu;
    this.previousVm = vm;
    this.previousAt = now;
    return {
      bootId: bootId.trim(),
      ...cpuDelta,
      ...memory,
      swapPagesPerSecond: Math.max(0, swapPagesPerSecond),
      temperatureC,
      clockSynchronized,
      filesystems,
    };
  }
}

async function filesystemSnapshot(path: string): Promise<FilesystemSnapshot> {
  try {
    const [stats, mount] = await Promise.all([
      statfs(path, { bigint: true }),
      execFileAsync('findmnt', ['-n', '-o', 'OPTIONS', '--target', path], { timeout: 5_000 }),
    ]);
    const used = Number((stats.blocks - stats.bfree) * stats.bsize);
    const free = Number(stats.bavail * stats.bsize);
    const files = Number(stats.files);
    const freeFiles = Number(stats.ffree);
    return {
      path,
      present: true,
      readOnly: mount.stdout.trim().split(',').includes('ro'),
      usedPct: used + free > 0 ? (used / (used + free)) * 100 : 0,
      freeBytes: free,
      inodeUsedPct: files > 0 ? ((files - freeFiles) / files) * 100 : null,
    };
  } catch {
    return { path, present: false, readOnly: false, usedPct: 0, freeBytes: 0, inodeUsedPct: null };
  }
}

async function readTemperature(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('sensors', ['-j'], { timeout: 5_000 });
    const values: number[] = [];
    collectTemperatureInputs(JSON.parse(stdout) as unknown, values);
    return values.length ? Math.max(...values) : null;
  } catch {
    return null;
  }
}

function collectTemperatureInputs(value: unknown, values: number[]): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith('_input') && typeof child === 'number' && Number.isFinite(child)) values.push(child);
    else collectTemperatureInputs(child, values);
  }
}

async function readClockSynchronized(): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 5_000 });
    return stdout.trim() === 'yes';
  } catch {
    return null;
  }
}

function parseCpu(text: string): CpuCounters {
  const fields = text.split('\n').find((line) => line.startsWith('cpu '))?.trim().split(/\s+/).slice(1).map(Number);
  if (!fields || fields.some((value) => !Number.isFinite(value))) throw new Error('/proc/stat inválido');
  const idle = (fields[3] ?? 0);
  const ioWait = (fields[4] ?? 0);
  return { total: fields.reduce((sum, value) => sum + value, 0), idle, ioWait };
}

function cpuPercent(previous: CpuCounters, current: CpuCounters): { cpuPct: number | null; ioWaitPct: number | null } {
  const total = current.total - previous.total;
  if (total <= 0) return { cpuPct: null, ioWaitPct: null };
  const idle = current.idle - previous.idle;
  const ioWait = current.ioWait - previous.ioWait;
  return {
    cpuPct: Math.max(0, ((total - idle - ioWait) / total) * 100),
    ioWaitPct: Math.max(0, (ioWait / total) * 100),
  };
}

function parseMemory(text: string): { memoryAvailablePct: number; swapUsedBytes: number } {
  const values = Object.fromEntries(text.split('\n').map((line) => {
    const match = line.match(/^(\w+):\s+(\d+)/);
    return match ? [match[1], Number(match[2]) * 1024] : ['', 0];
  }));
  const total = values.MemTotal ?? 0;
  const available = values.MemAvailable ?? 0;
  const swapTotal = values.SwapTotal ?? 0;
  const swapFree = values.SwapFree ?? 0;
  if (!total) throw new Error('/proc/meminfo inválido');
  return { memoryAvailablePct: (available / total) * 100, swapUsedBytes: Math.max(0, swapTotal - swapFree) };
}

function parseVm(text: string): VmCounters {
  const values = Object.fromEntries(text.split('\n').map((line) => {
    const [key, raw] = line.trim().split(/\s+/);
    return [key, Number(raw)];
  }));
  return { swapIn: values.pswpin ?? 0, swapOut: values.pswpout ?? 0 };
}

function pathId(path: string): string {
  return path === '/' ? 'root' : path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(bytes >= 10 * GIB ? 0 : 1)}GiB`;
}
