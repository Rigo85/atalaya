import { createHash, randomBytes } from 'node:crypto';
import type { Dispatcher } from '../dispatcher.js';
import type { HealthRegistry } from '../health.js';
import type { IncidentManager, MonitorMode } from '../incidents.js';
import type { StateStore } from '../state.js';

const SESSION_PREFIX = 'navidrome.session.';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface NavidromeMonitorConfig {
  url: string;
  username: string;
  password: string;
  metricsUrl: string;
  metricsPassword: string;
  intervalMs: number;
}

interface NowPlayingEntry {
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  username?: string;
  playerId?: string;
}

interface StoredSession {
  user: string;
  player: string;
  mediaId: string;
  media: string;
}

type FetchLike = typeof fetch;

/** Estado, reproduccion y metricas de Navidrome sin escribir PII en logs. */
export class NavidromeMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private cfg: NavidromeMonitorConfig,
    private mode: MonitorMode,
    private dispatcher: Dispatcher,
    private incidents: IncidentManager,
    private state: StateStore,
    private health: HealthRegistry,
    private log: Logger,
    private fetchFn: FetchLike = fetch,
  ) {
    health.register('navidrome');
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
      try {
        await this.ping();
        this.health.connected('navidrome');
        await this.incidents.observe({ key: 'navidrome.monitor', severity: 'ok', message: 'NAVIDROME: servicio operativo' });
      } catch {
        await this.unavailable();
        return;
      }
      if (this.cfg.username && this.cfg.password) await this.checkActivity();
      if (this.cfg.metricsUrl) await this.checkMetrics();
    } finally {
      this.running = false;
    }
  }

  private async unavailable(): Promise<void> {
      this.health.disconnected('navidrome', 'consulta Navidrome fallida');
      this.log.warn({}, 'consulta Navidrome falló');
      await this.incidents.observe({ key: 'navidrome.monitor', severity: 'warning', message: 'NAVIDROME: no se pudo comprobar el servicio' });
  }

  private async checkActivity(): Promise<void> {
    try {
      await this.consume(await this.nowPlaying());
    } catch {
      this.log.warn({}, 'consulta de actividad Navidrome falló');
      await this.incidents.observe({
        key: 'navidrome.activity', severity: 'warning', message: 'NAVIDROME: no se pudo consultar Now Playing',
      });
    }
  }

  private async ping(): Promise<void> {
    const response = await this.fetchFn(`${this.cfg.url}/ping`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Navidrome ping HTTP ${response.status}`);
  }

  private async nowPlaying(): Promise<NowPlayingEntry[]> {
    const salt = randomBytes(8).toString('hex');
    const token = createHash('md5').update(`${this.cfg.password}${salt}`).digest('hex');
    const url = new URL('/rest/getNowPlaying.view', `${this.cfg.url}/`);
    url.searchParams.set('u', this.cfg.username);
    url.searchParams.set('t', token);
    url.searchParams.set('s', salt);
    url.searchParams.set('v', '1.16.1');
    url.searchParams.set('c', 'atalaya');
    url.searchParams.set('f', 'json');
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Navidrome now playing HTTP ${response.status}`);
    const body = await response.json() as { 'subsonic-response'?: { status?: string; nowPlaying?: { entry?: unknown } } };
    const payload = body['subsonic-response'];
    if (payload?.status !== 'ok') throw new Error('Navidrome now playing rechazado');
    const entries = payload.nowPlaying?.entry ?? [];
    return Array.isArray(entries) ? entries as NowPlayingEntry[] : [];
  }

  private async checkMetrics(): Promise<void> {
    try {
      const headers = this.cfg.metricsPassword
        ? { authorization: `Basic ${Buffer.from(`navidrome:${this.cfg.metricsPassword}`).toString('base64')}` }
        : undefined;
      const response = await this.fetchFn(this.cfg.metricsUrl, { headers, signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      if (!response.ok || !text.includes('#')) throw new Error('metricas Navidrome invalidas');
      await this.incidents.observe({ key: 'navidrome.metrics', severity: 'ok', message: 'NAVIDROME: metricas operativas' });
    } catch {
      this.log.warn({}, 'consulta de metricas Navidrome falló');
      await this.incidents.observe({
        key: 'navidrome.metrics', severity: 'warning', message: 'NAVIDROME: metricas no disponibles',
      });
    }
  }

  private async consume(entries: NowPlayingEntry[]): Promise<void> {
    const initial = this.state.getServiceBaseline('navidrome.initialized') !== '1';
    const seen = new Set<string>();
    for (const entry of entries) {
      const current = toSession(entry);
      const key = `${SESSION_PREFIX}${safeKey(`${current.user}:${current.player}`)}`;
      seen.add(key);
      const previous = decodeSession(this.state.getServiceBaseline(key));
      if (!initial && !previous) {
        await this.emitActivity('navidrome.session-new', `navidrome:session:${stableId(key)}:${stableId(current.mediaId)}`, message(current));
      } else if (!initial && previous && current.mediaId && current.mediaId !== previous.mediaId) {
        await this.emitActivity('navidrome.playback-start', `navidrome:playback:${stableId(key)}:${stableId(current.mediaId)}`, message(current));
      }
      this.state.setServiceBaseline(key, JSON.stringify(current));
    }
    for (const [key] of this.state.serviceBaselineEntries(SESSION_PREFIX)) {
      if (!seen.has(key)) {
        this.state.removeServiceBaseline(key);
        if (!initial) this.state.incrInfo('navidrome.session-end');
      }
    }
    this.state.setServiceBaseline('navidrome.initialized', '1');
    await this.incidents.observe({ key: 'navidrome.activity', severity: 'ok', message: 'NAVIDROME: actividad operativa' });
  }

  private async emitActivity(tag: string, dedupKey: string, text: string): Promise<void> {
    if (this.mode !== 'live') {
      this.state.incrInfo(tag);
      this.log.info({ tag }, 'dry-run: actividad Navidrome detectada');
      return;
    }
    await this.dispatcher.emit({ level: 'event', tag, message: text, dedupKey });
  }
}

function toSession(entry: NowPlayingEntry): StoredSession {
  const user = compact(entry.username ?? 'usuario desconocido', 30);
  const player = compact(entry.playerId ?? user, 48);
  const title = compact(entry.title ?? 'tema desconocido', 54);
  const artist = compact(entry.artist ?? '', 36);
  const album = compact(entry.album ?? '', 36);
  return {
    user,
    player,
    mediaId: compact(entry.id ?? `${artist}:${title}:${album}`, 96),
    media: [artist, title, album ? `(${album})` : ''].filter(Boolean).join(' - '),
  };
}

function message(session: StoredSession): string {
  return `NAVIDROME: ${session.user} reproduce ${session.media}`;
}

function decodeSession(raw: string | undefined): StoredSession | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof value.user !== 'string' || typeof value.player !== 'string'
      || typeof value.mediaId !== 'string' || typeof value.media !== 'string') return undefined;
    return value as StoredSession;
  } catch {
    return undefined;
  }
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function stableId(value: string): string {
  let hash = 5381;
  for (const char of value) hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
  return (hash >>> 0).toString(36);
}

function compact(value: string, max: number): string {
  const ascii = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '?');
  return ascii.replace(/\s+/g, ' ').trim().slice(0, max) || 'sin datos';
}
