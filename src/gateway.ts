export interface GatewayConfig {
  url: string;
  apiKey: string;
  recipients: string[];
}

export interface SendOptions {
  message: string;
  priority: 'normal' | 'high' | 'critical';
  dedupKey?: string;
}

interface Logger {
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export type FetchLike = typeof fetch;

const RETRY_DELAYS_MS = [0, 2_000, 8_000];

/**
 * Cliente del notification-gateway. Reintento corto y descarte con log:
 * la cola persistente es responsabilidad del gateway, no de atalaya.
 */
export class GatewayClient {
  private cfg: GatewayConfig;
  private log: Logger;
  private fetchFn: FetchLike;

  constructor(cfg: GatewayConfig, log: Logger, fetchFn: FetchLike = fetch) {
    this.cfg = cfg;
    this.log = log;
    this.fetchFn = fetchFn;
  }

  async send(opts: SendOptions): Promise<boolean> {
    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await sleep(delay);
      try {
        const res = await this.fetchFn(`${this.cfg.url}/api/notifications`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.cfg.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            recipients: this.cfg.recipients,
            message: opts.message,
            priority: opts.priority,
            ...(opts.dedupKey ? { dedup_key: opts.dedupKey } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return true;
        // 4xx no mejora reintentando (key mala, payload inválido)
        if (res.status >= 400 && res.status < 500) {
          this.log.error({ status: res.status, body: await res.text() }, 'gateway rechazó la notificación');
          return false;
        }
        this.log.warn({ status: res.status }, 'gateway respondió error, reintentando');
      } catch (err) {
        this.log.warn({ err: String(err) }, 'gateway inalcanzable, reintentando');
      }
    }
    this.log.error({ message: opts.message }, 'notificación descartada tras reintentos');
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
