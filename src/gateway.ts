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
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/**
 * Cliente del notification-gateway. Reintento corto y descarte con log:
 * la cola persistente es responsabilidad del gateway, no de atalaya.
 */
export class GatewayClient {
  private cfg: GatewayConfig;
  private log: Logger;
  private fetchFn: FetchLike;
  private sleepFn: (ms: number) => Promise<void>;

  constructor(
    cfg: GatewayConfig,
    log: Logger,
    fetchFn: FetchLike = fetch,
    sleepFn: (ms: number) => Promise<void> = sleep,
  ) {
    this.cfg = cfg;
    this.log = log;
    this.fetchFn = fetchFn;
    this.sleepFn = sleepFn;
  }

  async send(opts: SendOptions): Promise<boolean> {
    let nextDelayMs = 0;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (nextDelayMs) await this.sleepFn(nextDelayMs);
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
        if (res.ok) {
          const body = await responseJson(res);
          if (body?.status === 'suppressed' && body.reason !== 'dedup') {
            this.log.error({ status: res.status, body }, 'gateway suprimió la notificación');
            return false;
          }
          return true;
        }
        // 4xx no mejora reintentando (key mala, payload inválido)
        if (res.status >= 400 && res.status < 500) {
          this.log.error({ status: res.status, body: await res.text() }, 'gateway rechazó la notificación');
          return false;
        }
        const retryAfterMs = res.status === 503 ? parseRetryAfterMs(res.headers.get('retry-after')) : null;
        nextDelayMs = retryAfterMs ?? RETRY_DELAYS_MS[attempt + 1] ?? 0;
        this.log.warn({ status: res.status, retryAfterMs: nextDelayMs }, 'gateway respondió error, reintentando');
      } catch (err) {
        nextDelayMs = RETRY_DELAYS_MS[attempt + 1] ?? 0;
        this.log.warn({ err: String(err) }, 'gateway inalcanzable, reintentando');
      }
    }
    this.log.error({ message: opts.message }, 'notificación descartada tras reintentos');
    return false;
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await response.text()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return null;
  return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
