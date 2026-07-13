import type { GatewayClient } from './gateway.js';
import { localDay, type StateStore } from './state.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

const CHECK_EVERY_MS = 30_000;

/**
 * Digest diario que además hace de heartbeat: se envía SIEMPRE a la hora
 * configurada, aunque diga "sin novedades". Si un día no llega, el host está mal.
 * El periodo de conteo va de digest a digest (state.rotate al enviar).
 */
export class DigestScheduler {
  private gateway: GatewayClient;
  private state: StateStore;
  private hour: number;
  private log: Logger;
  private now: () => Date;
  private timer?: NodeJS.Timeout;

  constructor(
    gateway: GatewayClient,
    state: StateStore,
    hour: number,
    log: Logger,
    now: () => Date = () => new Date(),
  ) {
    this.gateway = gateway;
    this.state = state;
    this.hour = hour;
    this.log = log;
    this.now = now;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const n = this.now();
    const day = localDay(n);
    if (n.getHours() < this.hour || this.state.data.lastDigestDate === day) return;
    const message = this.compose();
    const ok = await this.gateway.send({
      message,
      priority: 'normal',
      dedupKey: `atalaya:digest:${day}`,
    });
    if (ok) {
      this.state.rotate(day);
      this.log.info({ message }, 'digest enviado');
    } else {
      this.log.error({}, 'no se pudo enviar el digest; se reintentará en el próximo tick');
    }
  }

  /** ASCII puro (sin tildes) para mantenerse en GSM-7 / 160 chars. */
  compose(): string {
    const t = this.state.data.today;
    const n = this.now();
    const head = `Atalaya ${String(n.getDate()).padStart(2, '0')}/${String(n.getMonth() + 1).padStart(2, '0')}:`;
    const parts: string[] = [];
    if (t.critical > 0) parts.push(`${t.critical} critico${t.critical > 1 ? 's' : ''}`);
    if (t.warning > 0) parts.push(`${t.warning} aviso${t.warning > 1 ? 's' : ''}`);
    const top = Object.entries(t.info)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag, count]) => `${tag} x${count}`);
    parts.push(...top);
    const body = parts.length ? parts.join(', ') : 'sin novedades';
    let msg = `${head} ${body}`;
    if (msg.length > 158) msg = `${msg.slice(0, 155)}...`;
    return msg;
  }
}
