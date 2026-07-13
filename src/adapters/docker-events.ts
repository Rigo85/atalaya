import http from 'node:http';
import type { Dispatcher } from '../dispatcher.js';
import type { StateStore } from '../state.js';
import type { HealthRegistry } from '../health.js';

export interface DockerEventMsg {
  Type?: string;
  Action?: string;
  Actor?: { Attributes?: Record<string, string> };
}

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface DockerWatcherConfig {
  sockPath: string;
  downGraceMs: number;
  ignore: string[];
}

const RECONNECT_MS = 10_000;

/**
 * Reglas (plan F1 §4):
 *  - die exit!=0 → gracia; si no vuelve → critical; si vuelve → warning agrupada
 *  - die exit=0 (stop ordenado) → info (digest), sin olvidar el servicio
 *  - oom → critical directo
 *  - health_status unhealthy → warning agrupada
 *  - al arrancar: contenedores del inventario que no corren → warning
 */
export class DockerWatcher {
  private dispatcher: Dispatcher;
  private state: StateStore;
  private cfg: DockerWatcherConfig;
  private log: Logger;
  private health?: HealthRegistry;
  private pendingDown = new Map<string, NodeJS.Timeout>();
  private running = false;
  private streamRequest?: http.ClientRequest;
  private streamResponse?: http.IncomingMessage;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    dispatcher: Dispatcher,
    state: StateStore,
    cfg: DockerWatcherConfig,
    log: Logger,
    health?: HealthRegistry,
  ) {
    this.dispatcher = dispatcher;
    this.state = state;
    this.cfg = cfg;
    this.log = log;
    this.health = health;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.connect();
  }

  stop(): void {
    this.running = false;
    this.health?.disconnected('docker', 'watcher detenido');
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.streamResponse?.destroy();
    this.streamRequest?.destroy();
    this.streamResponse = undefined;
    this.streamRequest = undefined;
    for (const t of this.pendingDown.values()) clearTimeout(t);
    this.pendingDown.clear();
  }

  private async connect(): Promise<void> {
    try {
      await this.snapshot();
      this.streamEvents();
    } catch (err) {
      this.reconnect(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private ignored(name: string): boolean {
    return this.cfg.ignore.some((pat) => name.includes(pat));
  }

  /** inventario inicial: detecta lo que ya estaba caído antes de arrancar atalaya */
  private async snapshot(): Promise<void> {
    const body = await this.request('/containers/json');
    const running = (JSON.parse(body) as Array<{ Names: string[] }>)
      .map((c) => (c.Names[0] ?? '').replace(/^\//, ''))
      .filter((n) => n && !this.ignored(n));
    const missing = this.state.data.expectedContainers.filter((n) => !running.includes(n));
    for (const name of missing) {
      await this.dispatcher.emit({
        level: 'warning',
        tag: 'docker.missing',
        message: `DOCKER: ${name} no esta corriendo (estaba en el inventario)`,
        dedupKey: `docker:missing:${name}`,
      });
    }
    this.state.setExpectedContainers([...new Set([...this.state.data.expectedContainers, ...running])]);
    this.log.info({ running: running.length, missing }, 'snapshot docker inicial');
  }

  handleEvent(e: DockerEventMsg): void {
    if (e.Type !== 'container') return;
    const attrs = e.Actor?.Attributes ?? {};
    const name = attrs.name ?? '';
    if (!name || this.ignored(name)) return;
    const action = e.Action ?? '';

    if (action === 'die') {
      const exitCode = Number(attrs.exitCode ?? '0');
      if (exitCode === 0) {
        void this.dispatcher.emit({ level: 'info', tag: 'docker.stop' });
        return;
      }
      if (this.pendingDown.has(name)) return; // ya hay una gracia en curso
      const timer = setTimeout(() => {
        this.pendingDown.delete(name);
        void this.dispatcher.emit({
          level: 'critical',
          tag: 'docker.down',
          message: `DOCKER: ${name} caido (exit ${exitCode}) y no volvio en ${this.cfg.downGraceMs / 1000}s`,
          dedupKey: `docker:down:${name}`,
        });
      }, this.cfg.downGraceMs);
      this.pendingDown.set(name, timer);
      return;
    }

    if (action === 'start') {
      const pending = this.pendingDown.get(name);
      if (pending) {
        clearTimeout(pending);
        this.pendingDown.delete(name);
        void this.dispatcher.emit({
          level: 'warning',
          tag: 'docker.restart',
          message: `DOCKER: ${name} se reinicio solo`,
          dedupKey: `docker:restart:${name}`,
        });
      } else {
        void this.dispatcher.emit({ level: 'info', tag: 'docker.start' });
      }
      this.state.addExpectedContainer(name);
      return;
    }

    if (action === 'oom') {
      void this.dispatcher.emit({
        level: 'critical',
        tag: 'docker.oom',
        message: `DOCKER: ${name} sin memoria (OOM)`,
        dedupKey: `docker:oom:${name}`,
      });
      return;
    }

    if (action.startsWith('health_status') && action.includes('unhealthy')) {
      void this.dispatcher.emit({
        level: 'warning',
        tag: 'docker.unhealthy',
        message: `DOCKER: ${name} reporta unhealthy`,
        dedupKey: `docker:unhealthy:${name}`,
      });
    }
  }

  private streamEvents(): void {
    if (!this.running) return;
    const filters = encodeURIComponent(JSON.stringify({ type: ['container'] }));
    const req = http.get(
      { socketPath: this.cfg.sockPath, path: `/events?filters=${filters}` },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.reconnect(`stream Docker HTTP ${res.statusCode ?? 'sin status'}`);
          return;
        }
        this.streamResponse = res;
        this.health?.connected('docker');
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try {
              this.handleEvent(JSON.parse(line) as DockerEventMsg);
              this.health?.event('docker');
            } catch (err) {
              this.log.warn({ line, err: String(err) }, 'línea de evento docker no parseable');
            }
          }
        });
        res.once('end', () => this.reconnect('stream cerrado'));
        res.once('error', (err) => this.reconnect(String(err)));
      },
    );
    this.streamRequest = req;
    req.once('error', (err) => this.reconnect(String(err)));
  }

  private reconnect(reason: string): void {
    if (!this.running) return;
    this.health?.disconnected('docker', reason);
    this.streamResponse?.destroy();
    this.streamRequest?.destroy();
    this.streamResponse = undefined;
    this.streamRequest = undefined;
    if (this.reconnectTimer) return;
    this.log.warn({ reason }, `stream de docker events caído; reintento en ${RECONNECT_MS / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {});
    }, RECONNECT_MS);
  }

  private request(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get({ socketPath: this.cfg.sockPath, path, timeout: 5000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Docker HTTP ${res.statusCode ?? 'sin status'} en ${path}`));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout consultando docker')));
    });
  }
}
