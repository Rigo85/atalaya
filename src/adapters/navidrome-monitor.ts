import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Dispatcher } from '../dispatcher.js';
import type { HealthRegistry } from '../health.js';
import type { IncidentManager, MonitorMode } from '../incidents.js';
import type { StateStore } from '../state.js';

const SESSION_PREFIX = 'navidrome.session.';
const CLIENT_RECORD_RETRY_MS = 10_000;

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
  id?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  username?: unknown;
  playerId?: unknown;
}

interface StoredSession {
  user: string;
  player: string;
  mediaId: string;
  media: string;
  location: string;
}

type FetchLike = typeof fetch;
type LocateIp = (ip: string) => Promise<string>;

export interface NavidromeClientRecord {
  user: string;
  mediaId: string;
  ip: string;
  seenAt: string;
}

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
    private clientRecords?: () => Promise<NavidromeClientRecord[]>,
    private locateIp: LocateIp = () => Promise.resolve('ubicacion no disponible'),
    private waitForClientRecord: (ms: number) => Promise<void> = sleep,
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
      const entries = await this.nowPlayingWithRetry();
      let records = await this.loadClientRecords();
      if (this.needsClientRecordRetry(entries, records)) {
        await this.waitForClientRecord(CLIENT_RECORD_RETRY_MS);
        records = await this.loadClientRecords();
      }
      await this.consume(entries, records);
    } catch (error) {
      this.log.warn({ reason: activityFailureReason(error) }, 'consulta de actividad Navidrome falló');
      await this.incidents.observe({
        key: 'navidrome.activity', severity: 'warning', message: 'NAVIDROME: no se pudo consultar Now Playing',
      });
    }
  }

  private async loadClientRecords(): Promise<NavidromeClientRecord[]> {
    if (!this.clientRecords) return [];
    try {
      return await this.clientRecords();
    } catch {
      this.log.warn({}, 'ubicacion Navidrome no disponible');
      return [];
    }
  }

  private needsClientRecordRetry(entries: NowPlayingEntry[], records: NavidromeClientRecord[]): boolean {
    if (!this.clientRecords) return false;
    return entries.some((entry) => {
      const session = toSession(entry);
      const key = `${SESSION_PREFIX}${safeKey(`${session.user}:${session.player}`)}`;
      const previous = decodeSession(this.state.getServiceBaseline(key));
      const isNewMedia = !previous || previous.mediaId !== session.mediaId;
      const hasMatch = records.some((record) => record.user === session.user && record.mediaId === session.mediaId);
      return isNewMedia && !hasMatch;
    });
  }

  private async nowPlayingWithRetry(): Promise<NowPlayingEntry[]> {
    try {
      return await this.nowPlaying();
    } catch (error) {
      if (!isRetryableActivityFailure(error)) throw error;
      this.log.info({ reason: activityFailureReason(error) }, 'consulta de actividad Navidrome reintentando');
      return this.nowPlaying();
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
    if (!response.ok) throw new NowPlayingError('http', response.status);
    const body = await response.json() as { 'subsonic-response'?: { status?: string; nowPlaying?: { entry?: unknown } } };
    const payload = body['subsonic-response'];
    if (payload?.status !== 'ok') throw new NowPlayingError('rejected');
    return normalizeNowPlayingEntries(payload.nowPlaying?.entry);
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

  private async consume(entries: NowPlayingEntry[], records: NavidromeClientRecord[]): Promise<void> {
    const initial = this.state.getServiceBaseline('navidrome.initialized') !== '1';
    const seen = new Set<string>();
    for (const entry of entries) {
      const session = toSession(entry);
      const key = `${SESSION_PREFIX}${safeKey(`${session.user}:${session.player}`)}`;
      seen.add(key);
      const previous = decodeSession(this.state.getServiceBaseline(key));
      const current = await this.withLocation(session, records, previous);
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

  private async withLocation(
    current: StoredSession,
    records: NavidromeClientRecord[],
    previous?: StoredSession,
  ): Promise<StoredSession> {
    const previousLocation = previous?.mediaId === current.mediaId ? previous.location : '';
    const matches = records.filter((record) => record.user === current.user && record.mediaId === current.mediaId);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match) return { ...current, location: previousLocation };
    try {
      const location = isPrivateIp(match.ip) ? 'red local' : await this.locateIp(match.ip);
      return { ...current, location: location === 'ubicacion no disponible' ? '' : location };
    } catch {
      this.log.warn({}, 'ubicacion Navidrome no disponible');
      return { ...current, location: previousLocation };
    }
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

class NowPlayingError extends Error {
  constructor(readonly reason: 'http' | 'rejected', readonly status?: number) {
    super(reason);
  }
}

/** Clasifica sin registrar URL, token, credenciales ni metadatos de reproduccion. */
export function activityFailureReason(error: unknown): string {
  if (error instanceof NowPlayingError) {
    return error.reason === 'http' ? `http_${error.status ?? 'unknown'}` : 'subsonic_rejected';
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof SyntaxError) return 'invalid_json';
  if (error instanceof TypeError) {
    const code = networkErrorCode(error);
    if (code) return `network_${code.toLowerCase()}`;
    return isNetworkTypeError(error) ? 'network' : 'type_error';
  }
  return 'unknown';
}

function isRetryableActivityFailure(error: unknown): boolean {
  if (error instanceof NowPlayingError) return error.reason === 'http' && (error.status ?? 0) >= 500;
  return (error instanceof TypeError && isNetworkTypeError(error))
    || (error instanceof DOMException && error.name === 'TimeoutError');
}

function networkErrorCode(error: TypeError): string | undefined {
  const cause = (error as TypeError & { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object' || !('code' in cause)) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

function isNetworkTypeError(error: TypeError): boolean {
  return Boolean(networkErrorCode(error)) || error.message === 'fetch failed' || error.message === 'terminated';
}

function normalizeNowPlayingEntries(value: unknown): NowPlayingEntry[] {
  if (Array.isArray(value)) return value.filter(isNowPlayingEntry);
  return isNowPlayingEntry(value) ? [value] : [];
}

function isNowPlayingEntry(value: unknown): value is NowPlayingEntry {
  return Boolean(value) && typeof value === 'object';
}

function toSession(entry: NowPlayingEntry): StoredSession {
  const user = compact(entry.username, 30, 'usuario desconocido');
  const player = compact(entry.playerId, 48, user);
  const title = compact(entry.title, 54, 'tema desconocido');
  const artist = compact(entry.artist, 36, '');
  const album = compact(entry.album, 36, '');
  return {
    user,
    player,
    mediaId: compact(entry.id, 96, `${artist}:${title}:${album}`),
    media: [artist, title, album ? `(${album})` : ''].filter(Boolean).join(' - '),
    location: '',
  };
}

function message(session: StoredSession): string {
  return `NAVIDROME: ${session.user} reproduce ${session.media} desde ${session.location || 'ubicacion no disponible'}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeSession(raw: string | undefined): StoredSession | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof value.user !== 'string' || typeof value.player !== 'string'
      || typeof value.mediaId !== 'string' || typeof value.media !== 'string') return undefined;
    return { ...value, location: typeof value.location === 'string' ? value.location : '' } as StoredSession;
  } catch {
    return undefined;
  }
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b = 0] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function stableId(value: string): string {
  let hash = 5381;
  for (const char of value) hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
  return (hash >>> 0).toString(36);
}

function compact(value: unknown, max: number, fallback: string): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
  const ascii = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '?');
  return ascii.replace(/\s+/g, ' ').trim().slice(0, max) || fallback;
}
