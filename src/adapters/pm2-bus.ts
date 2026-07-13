import { createRequire } from 'node:module';
import type { Dispatcher } from '../dispatcher.js';

const require = createRequire(import.meta.url);

export interface Pm2EventPacket {
  event?: string; // 'online' | 'exit' | 'stop' | 'restart' | 'delete' | 'restart overlimit' ...
  process?: { name?: string; status?: string };
}

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface Pm2WatcherConfig {
  stormCount: number;
  stormWindowMs: number;
  /** nombre del propio proceso, para no auto-reportarse */
  selfName: string;
}

interface Pm2Like {
  connect(cb: (err?: Error) => void): void;
  launchBus(cb: (err: Error | undefined, bus: { on(ev: string, cb: (p: Pm2EventPacket) => void): void }) => void): void;
}

const RECONNECT_MS = 15_000;

/**
 * Reglas (plan F1 §5):
 *  - restart inesperado → warning agrupada
 *  - tormenta (>= stormCount en stormWindowMs) → critical
 *  - errored / restart overlimit → critical (pm2 se rindió)
 *  - stop manual → info (digest)
 */
export class Pm2Watcher {
  private dispatcher: Dispatcher;
  private cfg: Pm2WatcherConfig;
  private log: Logger;
  private restarts = new Map<string, number[]>();
  private stormNotified = new Set<string>();
  private now: () => number;

  constructor(dispatcher: Dispatcher, cfg: Pm2WatcherConfig, log: Logger, now: () => number = Date.now) {
    this.dispatcher = dispatcher;
    this.cfg = cfg;
    this.log = log;
    this.now = now;
  }

  start(): void {
    const pm2 = require('pm2') as Pm2Like;
    pm2.connect((err) => {
      if (err) {
        this.log.warn({ err: String(err) }, `pm2 connect falló; reintento en ${RECONNECT_MS / 1000}s`);
        setTimeout(() => this.start(), RECONNECT_MS);
        return;
      }
      pm2.launchBus((busErr, bus) => {
        if (busErr) {
          this.log.warn({ err: String(busErr) }, `pm2 launchBus falló; reintento en ${RECONNECT_MS / 1000}s`);
          setTimeout(() => this.start(), RECONNECT_MS);
          return;
        }
        bus.on('process:event', (packet) => void this.handleEvent(packet));
        this.log.info({}, 'pm2 bus conectado');
      });
    });
  }

  async handleEvent(packet: Pm2EventPacket): Promise<void> {
    const name = packet.process?.name;
    const event = packet.event ?? '';
    if (!name || name === this.cfg.selfName) return;

    if (event === 'restart overlimit' || packet.process?.status === 'errored') {
      await this.dispatcher.emit({
        level: 'critical',
        tag: 'pm2.errored',
        message: `[PM2] ${name} en estado errored (pm2 se rindio)`,
        dedupKey: `pm2:errored:${name}`,
      });
      return;
    }

    if (event === 'restart') {
      const times = this.restarts.get(name) ?? [];
      const cutoff = this.now() - this.cfg.stormWindowMs;
      const recent = [...times.filter((t) => t > cutoff), this.now()];
      this.restarts.set(name, recent);

      if (recent.length >= this.cfg.stormCount) {
        if (!this.stormNotified.has(name)) {
          this.stormNotified.add(name);
          setTimeout(() => this.stormNotified.delete(name), this.cfg.stormWindowMs);
          await this.dispatcher.emit({
            level: 'critical',
            tag: 'pm2.storm',
            message: `[PM2] ${name} en bucle de reinicios (${recent.length} en ${this.cfg.stormWindowMs / 60000} min)`,
            dedupKey: `pm2:storm:${name}`,
          });
        }
        return;
      }
      await this.dispatcher.emit({
        level: 'warning',
        tag: 'pm2.restart',
        message: `[PM2] ${name} se reinicio`,
        dedupKey: `pm2:restart:${name}`,
      });
      return;
    }

    if (event === 'stop' || event === 'delete') {
      await this.dispatcher.emit({ level: 'info', tag: 'pm2.stop' });
    }
  }
}
