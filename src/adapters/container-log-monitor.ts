import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HealthRegistry, AdapterName } from '../health.js';
import type { IncidentManager } from '../incidents.js';
import type { StateStore } from '../state.js';

const execFileAsync = promisify(execFile);

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface ContainerLogMonitorConfig {
  container: string;
  adapter: AdapterName;
  stateKey: string;
  tag: string;
  incidentKey: string;
  serviceLabel: string;
  intervalMs: number;
  errorThreshold: number;
  matchesError: (line: string) => boolean;
}

type LogReader = (container: string, since: Date) => Promise<string[]>;

/** Cuenta patrones de error recientes sin persistir ni exponer contenido de logs. */
export class ContainerLogMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private cfg: ContainerLogMonitorConfig,
    private incidents: IncidentManager,
    private state: StateStore,
    private health: HealthRegistry,
    private log: Logger,
    private readLogs: LogReader = dockerLogLines,
    private now: () => Date = () => new Date(),
  ) {
    health.register(cfg.adapter);
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      const cursor = this.state.getServiceBaseline(this.cfg.stateKey);
      const initial = !cursor;
      const since = cursor ? new Date(cursor) : new Date(now.getTime() - this.cfg.intervalMs);
      const lines = await this.readLogs(this.cfg.container, since);
      this.state.setServiceBaseline(this.cfg.stateKey, now.toISOString());
      this.health.connected(this.cfg.adapter);
      const errors = lines.filter(this.cfg.matchesError).length;
      if (initial) {
        if (errors) this.state.incrInfoBy(`${this.cfg.tag}.log-baseline`, errors);
        return;
      }
      if (errors) this.state.incrInfoBy(`${this.cfg.tag}.log-error`, errors);
      await this.incidents.observe({
        key: this.cfg.incidentKey,
        severity: errors >= this.cfg.errorThreshold ? 'warning' : 'ok',
        message: `${this.cfg.serviceLabel}: ${errors} errores de aplicacion en el ultimo intervalo`,
      });
    } catch {
      this.health.disconnected(this.cfg.adapter, 'lectura de logs fallida');
      this.log.warn({ container: this.cfg.container }, 'lectura de logs del servicio falló');
      await this.incidents.observe({
        key: `${this.cfg.incidentKey}.reader`, severity: 'warning',
        message: `${this.cfg.serviceLabel}: no se pudieron leer los logs`,
      });
    } finally {
      this.running = false;
    }
  }
}

async function dockerLogLines(container: string, since: Date): Promise<string[]> {
  const { stdout, stderr } = await execFileAsync(
    'docker', ['logs', '--timestamps', '--since', since.toISOString(), container],
    { timeout: 10_000, maxBuffer: 512 * 1024 },
  );
  return `${stdout}\n${stderr}`.split(/\r?\n/).filter(Boolean);
}

export function aonsokuLogError(line: string): boolean {
  return /\[(?:crit|alert|emerg|error)\]|\s5\d{2}\s/.test(line);
}

export function navidromeLogError(line: string): boolean {
  return /\blevel=(?:error|fatal)\b|\bpanic\b|\bexception\b|\berror=[1-9]\d*/i.test(line);
}
