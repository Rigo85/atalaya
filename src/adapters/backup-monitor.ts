import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { HealthRegistry } from '../health.js';
import type { IncidentManager, IncidentSeverity } from '../incidents.js';

const execFileAsync = promisify(execFile);
const BACKUP_PATTERN = /^books-store_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.sql\.gz$/;
const WARNING_AGE_MS = 8 * 60 * 60_000;
const CRITICAL_AGE_MS = 14 * 60 * 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;

interface Logger {
  warn: (obj: object, msg: string) => void;
}

interface BackupFile {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export class BackupMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private directory: string,
    private intervalMs: number,
    private incidents: IncidentManager,
    private health: HealthRegistry,
    private log: Logger,
    private now: () => number = Date.now,
    private verifyGzip: (path: string) => Promise<void> = gzipTest,
  ) {
    health.register('backup');
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
      const entries = await readdir(this.directory, { withFileTypes: true });
      const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry): Promise<BackupFile> => {
        const path = join(this.directory, entry.name);
        const fileStat = await stat(path);
        return { name: entry.name, path, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
      }));
      const expected = files.filter((file) => BACKUP_PATTERN.test(file.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
      await this.evaluateNewest(expected[0]);
      await this.evaluateRetention(files, expected);
      this.health.connected('backup');
    } catch (err) {
      this.health.disconnected('backup', String(err));
      this.log.warn({ directory: this.directory, err: String(err) }, 'backup check falló');
      await this.incidents.observe({
        key: 'backup.libretorio.monitor', severity: 'critical',
        message: `BACKUP libretorio: no se pudo revisar ${this.directory}`,
      });
    } finally {
      this.running = false;
    }
  }

  private async evaluateNewest(newest: BackupFile | undefined): Promise<void> {
    if (!newest) {
      await this.incidents.observe({
        key: 'backup.libretorio.freshness', severity: 'critical',
        message: 'BACKUP libretorio: no hay archivos válidos',
      });
      return;
    }
    const ageMs = Math.max(0, this.now() - newest.mtimeMs);
    let severity: IncidentSeverity = ageMs >= CRITICAL_AGE_MS
      ? 'critical' : ageMs >= WARNING_AGE_MS ? 'warning' : 'ok';
    let detail = `ultimo hace ${formatAge(ageMs)}, ${(newest.size / 1024 ** 2).toFixed(1)}MiB`;
    if (newest.size === 0) {
      severity = 'critical';
      detail = 'ultimo archivo vacío';
    } else {
      try {
        await this.verifyGzip(newest.path);
      } catch {
        severity = 'critical';
        detail = 'ultimo gzip corrupto';
      }
    }
    await this.incidents.observe({
      key: 'backup.libretorio.freshness', severity,
      message: `BACKUP libretorio: ${detail}`,
    });
    await this.incidents.observe({
      key: 'backup.libretorio.monitor', severity: 'ok', message: 'backup monitor operativo',
    });
  }

  private async evaluateRetention(files: BackupFile[], expected: BackupFile[]): Promise<void> {
    const cutoff = this.now() - RETENTION_MS;
    const expired = expected.filter((file) => file.mtimeMs < cutoff);
    const unknownExpired = files.filter((file) => !BACKUP_PATTERN.test(file.name) && file.mtimeMs < cutoff);
    const severity: IncidentSeverity = expired.length || unknownExpired.length ? 'warning' : 'ok';
    const details = [
      expired.length ? `${expired.length} vencidos` : '',
      unknownExpired.length ? `${unknownExpired.length} desconocidos antiguos` : '',
    ].filter(Boolean).join(', ');
    await this.incidents.observe({
      key: 'backup.libretorio.retention', severity,
      message: severity === 'ok' ? 'BACKUP libretorio: retencion 30d correcta' : `BACKUP libretorio: ${details}`,
    });
  }
}

async function gzipTest(path: string): Promise<void> {
  await execFileAsync('gzip', ['-t', '--', path], { timeout: 60_000 });
}

function formatAge(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}
