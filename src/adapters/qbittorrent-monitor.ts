import type { HealthRegistry } from '../health.js';
import type { IncidentManager } from '../incidents.js';
import type { StateStore } from '../state.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface QbittorrentMonitorConfig {
  url: string;
  username: string;
  password: string;
  intervalMs: number;
}

interface Torrent {
  name?: string;
  state?: string;
  completion_on?: number;
}

interface MainData {
  rid: number;
  full_update: boolean;
  torrents?: Record<string, Torrent>;
  torrents_removed?: string[];
}

interface StoredTorrent {
  name: string;
  state: string;
  complete: boolean;
}

type FetchLike = typeof fetch;

/** Usa el feed incremental de qBittorrent; el primer snapshot solo establece baseline. */
export class QbittorrentMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private config: QbittorrentMonitorConfig,
    private incidents: IncidentManager,
    private state: StateStore,
    private health: HealthRegistry,
    private log: Logger,
    private fetchFn: FetchLike = fetch,
  ) {
    health.register('qbittorrent');
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cookie = await this.login();
      const rid = this.state.getServiceBaseline('qbit.rid') ?? '0';
      const data = await this.mainData(cookie, rid);
      await this.consume(data);
      this.health.connected('qbittorrent');
    } catch (err) {
      this.health.disconnected('qbittorrent', 'consulta qBittorrent fallida');
      this.log.warn({ err: String(err) }, 'consulta qBittorrent falló');
      await this.incidents.observe({
        key: 'qbit.monitor', severity: 'warning', message: 'QBITTORRENT: no se pudo consultar la API',
      });
    } finally {
      this.running = false;
    }
  }

  private async login(): Promise<string> {
    const response = await this.fetchFn(`${this.config.url}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: this.config.username, password: this.config.password }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`qBittorrent login HTTP ${response.status}`);
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie) throw new Error('qBittorrent no entregó sesión');
    return cookie;
  }

  private async mainData(cookie: string, rid: string): Promise<MainData> {
    const response = await this.fetchFn(`${this.config.url}/api/v2/sync/maindata?rid=${encodeURIComponent(rid)}`, {
      headers: { cookie }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`qBittorrent sync HTTP ${response.status}`);
    const data = await response.json() as MainData;
    if (!Number.isInteger(data.rid) || typeof data.full_update !== 'boolean') {
      throw new Error('respuesta incremental qBittorrent inválida');
    }
    return data;
  }

  private async consume(data: MainData): Promise<void> {
    const initial = this.state.getServiceBaseline('qbit.initialized') !== '1';
    for (const hash of data.torrents_removed ?? []) this.state.removeServiceBaseline(torrentKey(hash));
    for (const [hash, patch] of Object.entries(data.torrents ?? {})) {
      const key = torrentKey(hash);
      const previous = decodeTorrent(this.state.getServiceBaseline(key));
      const current: StoredTorrent = {
        name: limitedName(patch.name ?? previous?.name ?? 'descarga sin nombre'),
        state: patch.state ?? previous?.state ?? '',
        complete: isComplete(patch, previous),
      };
      if (!initial && !previous) this.state.incrInfo('qbit.download-new');
      if (!initial && previous && !previous.complete && current.complete) {
        this.state.incrInfo('qbit.download-complete');
      }
      const errored = current.state.toLowerCase() === 'error';
      await this.incidents.observe({
        key: `qbit.error.${safeKey(hash)}`,
        severity: errored ? 'warning' : 'ok',
        message: errored ? `QBITTORRENT: descarga con error (${current.name})` : 'QBITTORRENT: descarga sin error',
      });
      this.state.setServiceBaseline(key, JSON.stringify(current));
    }
    this.state.setServiceBaseline('qbit.rid', String(data.rid));
    this.state.setServiceBaseline('qbit.initialized', '1');
    await this.incidents.observe({ key: 'qbit.monitor', severity: 'ok', message: 'QBITTORRENT: API operativa' });
  }
}

function isComplete(patch: Torrent, previous?: StoredTorrent): boolean {
  if (typeof patch.completion_on === 'number') return patch.completion_on > 0;
  return previous?.complete ?? false;
}

function torrentKey(hash: string): string {
  return `qbit.torrent.${safeKey(hash)}`;
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function decodeTorrent(raw: string | undefined): StoredTorrent | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StoredTorrent>;
    if (typeof value.name !== 'string' || typeof value.state !== 'string' || typeof value.complete !== 'boolean') return undefined;
    return value as StoredTorrent;
  } catch {
    return undefined;
  }
}

function limitedName(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 72) || 'descarga sin nombre';
}
