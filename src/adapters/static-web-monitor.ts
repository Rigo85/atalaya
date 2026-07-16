import type { HealthRegistry } from '../health.js';
import type { IncidentManager } from '../incidents.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface StaticWebMonitorConfig {
  name: string;
  url: string;
  requiredPaths: string[];
  intervalMs: number;
}

type FetchLike = typeof fetch;

/** Comprueba que una SPA y sus archivos de configuracion esenciales se puedan servir. */
export class StaticWebMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private failures = 0;

  constructor(
    private cfg: StaticWebMonitorConfig,
    private incidents: IncidentManager,
    private health: HealthRegistry,
    private log: Logger,
    private fetchFn: FetchLike = fetch,
  ) {
    health.register('aonsoku');
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
      for (const path of this.cfg.requiredPaths) await this.probe(path);
      this.failures = 0;
      this.health.connected('aonsoku');
      await this.incidents.observe({ key: 'aonsoku.static', severity: 'ok', message: 'AONSOKU: SPA operativa' });
    } catch (err) {
      this.failures++;
      this.health.disconnected('aonsoku', 'comprobacion de SPA fallida');
      this.log.warn({ failures: this.failures }, 'comprobacion Aonsoku falló');
      if (this.failures >= 2) {
        await this.incidents.observe({
          key: 'aonsoku.static', severity: 'warning',
          message: 'AONSOKU: SPA o configuracion estatica no disponible',
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async probe(path: string): Promise<void> {
    const url = new URL(path, `${this.cfg.url}/`).toString();
    const response = await this.fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    if (!response.ok || body.trim().length === 0) throw new Error(`HTTP ${response.status}`);
    if (path === '/' && !contentType.includes('text/html')) throw new Error('inicio no es HTML');
    if (path.endsWith('.js') && !/(javascript|text\/plain)/i.test(contentType)) throw new Error('configuracion no es JavaScript');
  }
}
