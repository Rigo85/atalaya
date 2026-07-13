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

export type GatewaySendOutcome = 'accepted' | 'deduplicated' | 'rejected';

export interface GatewaySendResult {
  outcome: GatewaySendOutcome;
  status?: number;
  reason?: string;
}

interface Logger {
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export type FetchLike = typeof fetch;
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const RETRY_DELAYS_MS = [0, 2_000, 8_000];
const MAX_RETRY_AFTER_MS = 5 * 60_000;

export class GatewayClient {
  private controller = new AbortController();

  constructor(
    private cfg: GatewayConfig,
    private log: Logger,
    private fetchFn: FetchLike = fetch,
    private sleepFn: Sleep = sleep,
  ) {}

  stop(): void {
    this.controller.abort();
  }

  async send(opts: SendOptions): Promise<GatewaySendResult> {
    let nextDelayMs = 0;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (nextDelayMs) {
        try {
          await this.sleepFn(nextDelayMs, this.controller.signal);
        } catch {
          return { outcome: 'rejected', reason: 'shutdown' };
        }
      }
      if (this.controller.signal.aborted) return { outcome: 'rejected', reason: 'shutdown' };
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
          signal: AbortSignal.any([AbortSignal.timeout(10_000), this.controller.signal]),
        });
        if (res.ok) {
          const body = await responseJson(res);
          if (body?.status === 'suppressed') {
            if (body.reason === 'dedup') return { outcome: 'deduplicated', status: res.status, reason: 'dedup' };
            this.log.error({ status: res.status, body }, 'gateway suprimió la notificación');
            return { outcome: 'rejected', status: res.status, reason: 'suppressed' };
          }
          return { outcome: 'accepted', status: res.status };
        }
        if (res.status >= 400 && res.status < 500) {
          this.log.error({ status: res.status, body: await res.text() }, 'gateway rechazó la notificación');
          return { outcome: 'rejected', status: res.status, reason: 'client_error' };
        }
        const retryAfterMs = res.status === 503 ? parseRetryAfterMs(res.headers.get('retry-after')) : null;
        nextDelayMs = retryAfterMs ?? RETRY_DELAYS_MS[attempt + 1] ?? 0;
        if (attempt + 1 < RETRY_DELAYS_MS.length) {
          this.log.warn({ status: res.status, retryAfterMs: nextDelayMs }, 'gateway respondió error, reintentando');
        }
      } catch (err) {
        if (this.controller.signal.aborted) return { outcome: 'rejected', reason: 'shutdown' };
        nextDelayMs = RETRY_DELAYS_MS[attempt + 1] ?? 0;
        if (attempt + 1 < RETRY_DELAYS_MS.length) this.log.warn({ err: String(err) }, 'gateway inalcanzable, reintentando');
      }
    }
    this.log.error({}, 'notificación descartada tras reintentos');
    return { outcome: 'rejected', reason: 'retries_exhausted' };
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
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return null;
  return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
