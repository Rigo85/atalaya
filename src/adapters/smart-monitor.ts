import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HealthRegistry } from '../health.js';
import type { IncidentManager } from '../incidents.js';
import type { StateStore } from '../state.js';

const execFileAsync = promisify(execFile);

export interface SmartDiskSnapshot {
  id: string;
  passed: boolean;
  temperatureC: number | null;
  reallocated: number;
  pending: number;
  offlineUncorrectable: number;
  crcErrors: number;
}

export interface SmartSnapshot {
  disks: SmartDiskSnapshot[];
  pools: Array<{ name: string; health: string }>;
}

interface Logger {
  warn: (obj: object, msg: string) => void;
}

export class SmartMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private command: string,
    private intervalMs: number,
    private incidents: IncidentManager,
    private state: StateStore,
    private health: HealthRegistry,
    private log: Logger,
    private snapshotFn: () => Promise<SmartSnapshot> = () => runSnapshot(command),
  ) {
    health.register('smart');
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
      const snapshot = await this.snapshotFn();
      for (const disk of snapshot.disks) await this.evaluateDisk(disk);
      const temperatures = snapshot.disks.filter((disk) => disk.temperatureC !== null);
      const hottest = temperatures.sort((a, b) => (b.temperatureC ?? 0) - (a.temperatureC ?? 0))[0];
      const hotCount = temperatures.filter((disk) => (disk.temperatureC ?? 0) >= 50).length;
      const hottestC = hottest?.temperatureC ?? null;
      await this.incidents.observe({
        key: 'smart.temperature',
        severity: hottestC !== null && hottestC >= 60 ? 'critical' : hotCount > 0 ? 'warning' : 'ok',
        message: hottestC === null
          ? 'SMART: temperaturas no disponibles'
          : `SMART: ${hotCount} discos >=50C, max ${hottestC}C (${hottest?.id})`,
      });
      for (const pool of snapshot.pools) {
        await this.incidents.observe({
          key: `zfs.${safeId(pool.name)}`,
          severity: pool.health === 'ONLINE' ? 'ok' : 'critical',
          message: `ZFS ${pool.name}: ${pool.health}`,
        });
      }
      await this.incidents.observe({
        key: 'smart.monitor', severity: 'ok', message: 'SMART monitor operativo',
      });
      this.health.connected('smart');
    } catch (err) {
      this.health.disconnected('smart', String(err));
      this.log.warn({ err: String(err) }, 'SMART check falló');
      await this.incidents.observe({
        key: 'smart.monitor', severity: 'warning', message: `SMART: no se pudo consultar (${String(err)})`,
      });
    } finally {
      this.running = false;
    }
  }

  private async evaluateDisk(disk: SmartDiskSnapshot): Promise<void> {
    const id = safeId(disk.id);
    const critical = !disk.passed || disk.pending > 0 || disk.offlineUncorrectable > 0;
    await this.incidents.observe({
      key: `smart.${id}.health`,
      severity: critical ? 'critical' : 'ok',
      message: `SMART ${disk.id}: ${disk.passed ? 'OK' : 'FAILED'}, pending ${disk.pending}, uncorrectable ${disk.offlineUncorrectable}`,
    });

    const baseline = this.state.getSmartBaseline(disk.id);
    if (baseline) {
      const reallocatedGrowth = disk.reallocated - baseline.reallocated;
      const crcGrowth = disk.crcErrors - baseline.crcErrors;
      await this.incidents.observe({
        key: `smart.${id}.reallocated`,
        severity: reallocatedGrowth > 0 ? 'warning' : 'ok',
        message: `SMART ${disk.id}: sectores reasignados +${Math.max(0, reallocatedGrowth)} (${disk.reallocated})`,
      });
      await this.incidents.observe({
        key: `smart.${id}.crc`,
        severity: crcGrowth > 0 ? 'warning' : 'ok',
        message: `SMART ${disk.id}: errores CRC +${Math.max(0, crcGrowth)} (${disk.crcErrors})`,
      });
    }
    this.state.setSmartBaseline(disk.id, {
      reallocated: disk.reallocated,
      pending: disk.pending,
      offlineUncorrectable: disk.offlineUncorrectable,
      crcErrors: disk.crcErrors,
    });
  }
}

async function runSnapshot(command: string): Promise<SmartSnapshot> {
  const { stdout } = await execFileAsync('sudo', ['-n', command], { timeout: 120_000 });
  const value = JSON.parse(stdout) as Partial<SmartSnapshot>;
  if (!Array.isArray(value.disks) || !Array.isArray(value.pools)) throw new Error('snapshot SMART inválido');
  return value as SmartSnapshot;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}
