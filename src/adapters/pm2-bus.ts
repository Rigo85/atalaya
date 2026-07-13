import { createRequire } from 'node:module';
import type { Dispatcher } from '../dispatcher.js';
import type { HealthRegistry } from '../health.js';

const require = createRequire(import.meta.url);

export interface Pm2EventPacket {
  event?: string;
  process?: { name?: string; status?: string };
}

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface Pm2WatcherConfig {
  stormCount: number;
  stormWindowMs: number;
  selfName: string;
}

interface EventSource {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface Pm2Like {
  connect(cb: (err?: Error) => void): void;
  launchBus(cb: (err: Error | undefined, bus: EventSource, socket?: EventSource) => void): void;
  disconnect?(): void;
}

const RECONNECT_MS = 15_000;

export class Pm2Watcher {
  private restarts = new Map<string, number[]>();
  private stormNotified = new Set<string>();
  private running = false;
  private reconnectTimer?: NodeJS.Timeout;
  private bus?: EventSource;
  private socket?: EventSource;
  private pm2?: Pm2Like;

  private readonly processListener = (packet: unknown): void => {
    this.health?.event('pm2');
    void this.handleEvent(packet as Pm2EventPacket);
  };
  private readonly connectListener = (): void => {
    this.health?.connected('pm2');
    this.log.info({}, 'pm2 bus conectado');
  };
  private readonly reconnectListener = (): void => {
    this.health?.disconnected('pm2', 'reconectando socket PM2');
  };
  private readonly closeListener = (): void => {
    this.health?.disconnected('pm2', 'socket PM2 cerrado');
  };

  constructor(
    private dispatcher: Dispatcher,
    private cfg: Pm2WatcherConfig,
    private log: Logger,
    private now: () => number = Date.now,
    private health?: HealthRegistry,
    private pm2Factory: () => Pm2Like = () => require('pm2') as Pm2Like,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.health?.disconnected('pm2', 'watcher detenido');
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    remove(this.bus, 'process:event', this.processListener);
    remove(this.socket, 'connect', this.connectListener);
    remove(this.socket, 'reconnect attempt', this.reconnectListener);
    remove(this.socket, 'close', this.closeListener);
    this.bus = undefined;
    this.socket = undefined;
    this.pm2?.disconnect?.();
    this.pm2 = undefined;
  }

  private connect(): void {
    if (!this.running) return;
    const pm2 = this.pm2Factory();
    this.pm2 = pm2;
    pm2.connect((err) => {
      if (!this.running) return;
      if (err) {
        this.health?.disconnected('pm2', String(err));
        this.scheduleReconnect(`pm2 connect falló: ${String(err)}`);
        return;
      }
      pm2.launchBus((busErr, bus, socket) => {
        if (!this.running) return;
        if (busErr) {
          this.health?.disconnected('pm2', String(busErr));
          this.scheduleReconnect(`pm2 launchBus falló: ${String(busErr)}`);
          return;
        }
        this.bus = bus;
        this.socket = socket;
        bus.on('process:event', this.processListener);
        socket?.on('connect', this.connectListener);
        socket?.on('reconnect attempt', this.reconnectListener);
        socket?.on('close', this.closeListener);
        this.health?.connected('pm2');
        this.log.info({}, 'pm2 bus conectado');
      });
    });
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running || this.reconnectTimer) return;
    this.log.warn({ reason }, `PM2 no disponible; reintento en ${RECONNECT_MS / 1000}s`);
    this.pm2?.disconnect?.();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, RECONNECT_MS);
  }

  async handleEvent(packet: Pm2EventPacket): Promise<void> {
    const name = packet.process?.name;
    const event = packet.event ?? '';
    if (!name || name === this.cfg.selfName) return;

    if (event === 'restart overlimit' || packet.process?.status === 'errored') {
      await this.dispatcher.emit({
        level: 'critical', tag: 'pm2.errored',
        message: `PM2: ${name} en estado errored (pm2 se rindio)`, dedupKey: `pm2:errored:${name}`,
      });
      return;
    }

    if (event === 'restart') {
      const times = this.restarts.get(name) ?? [];
      const cutoff = this.now() - this.cfg.stormWindowMs;
      const recent = [...times.filter((time) => time > cutoff), this.now()];
      this.restarts.set(name, recent);
      if (recent.length >= this.cfg.stormCount) {
        if (!this.stormNotified.has(name)) {
          this.stormNotified.add(name);
          setTimeout(() => this.stormNotified.delete(name), this.cfg.stormWindowMs);
          await this.dispatcher.emit({
            level: 'critical', tag: 'pm2.storm',
            message: `PM2: ${name} en bucle de reinicios (${recent.length} en ${this.cfg.stormWindowMs / 60000} min)`,
            dedupKey: `pm2:storm:${name}`,
          });
        }
        return;
      }
      await this.dispatcher.emit({
        level: 'warning', tag: 'pm2.restart', message: `PM2: ${name} se reinicio`,
        dedupKey: `pm2:restart:${name}`,
      });
      return;
    }

    if (event === 'stop' || event === 'delete') {
      await this.dispatcher.emit({ level: 'info', tag: 'pm2.stop' });
    }
  }
}

function remove(source: EventSource | undefined, event: string, listener: (...args: unknown[]) => void): void {
  source?.off?.(event, listener);
  if (!source?.off) source?.removeListener?.(event, listener);
}
