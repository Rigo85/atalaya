import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import type { Dispatcher } from '../dispatcher.js';
import type { HealthRegistry } from '../health.js';
import type { IncidentManager, MonitorMode } from '../incidents.js';
import type { StateStore } from '../state.js';

const execFileAsync = promisify(execFile);
const SESSION_PREFIX = 'jellyfin.session.';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface JellyfinMonitorConfig {
  url: string;
  apiKey: string;
  intervalMs: number;
}

interface JellyfinSession {
  Id?: string;
  UserName?: string;
  DeviceName?: string;
  RemoteEndPoint?: string;
  NowPlayingItem?: {
    Name?: string;
    SeriesName?: string;
    AlbumArtist?: string;
  };
}

interface StoredSession {
  user: string;
  device: string;
  location: string;
  media: string;
}

type FetchLike = typeof fetch;
type LocateIp = (ip: string) => Promise<string>;

/** Actividad Jellyfin: baseline inicial, eventos inmediatos y resumen diario. */
export class JellyfinMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private config: JellyfinMonitorConfig,
    private mode: MonitorMode,
    private dispatcher: Dispatcher,
    private incidents: IncidentManager,
    private state: StateStore,
    private health: HealthRegistry,
    private log: Logger,
    private fetchFn: FetchLike = fetch,
    private locateIp: LocateIp = () => Promise.resolve('ubicacion no disponible'),
  ) {
    health.register('jellyfin');
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
      const sessions = await this.fetchSessions();
      await this.consume(sessions);
      this.health.connected('jellyfin');
    } catch (err) {
      this.health.disconnected('jellyfin', 'consulta Jellyfin fallida');
      this.log.warn({ err: String(err) }, 'consulta Jellyfin falló');
      await this.incidents.observe({
        key: 'jellyfin.monitor', severity: 'warning', message: 'JELLYFIN: no se pudo consultar la API',
      });
    } finally {
      this.running = false;
    }
  }

  private async fetchSessions(): Promise<JellyfinSession[]> {
    const response = await this.fetchFn(`${this.config.url}/Sessions`, {
      headers: { 'X-Emby-Token': this.config.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Jellyfin HTTP ${response.status}`);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error('respuesta Jellyfin Sessions inválida');
    return value as JellyfinSession[];
  }

  private async consume(sessions: JellyfinSession[]): Promise<void> {
    const initial = this.state.getServiceBaseline('jellyfin.initialized') !== '1';
    const seen = new Set<string>();
    for (const session of sessions) {
      if (!session.Id) continue;
      const key = `${SESSION_PREFIX}${safeKey(session.Id)}`;
      seen.add(key);
      const previous = decodeSession(this.state.getServiceBaseline(key));
      const current = await this.toStoredSession(session, previous);
      if (!initial && !previous) {
        await this.emitActivity('jellyfin.session-new', `jellyfin:session:${safeKey(session.Id)}`, connectionMessage(current));
      } else if (!initial && previous && current.media && current.media !== previous.media) {
        await this.emitActivity(
          'jellyfin.playback-start',
          `jellyfin:playback:${safeKey(session.Id)}:${stableId(current.media)}`,
          playbackMessage(current),
        );
      }
      this.state.setServiceBaseline(key, JSON.stringify(current));
    }
    for (const [key] of this.state.serviceBaselineEntries(SESSION_PREFIX)) {
      if (!seen.has(key)) this.state.removeServiceBaseline(key);
    }
    this.state.setServiceBaseline('jellyfin.initialized', '1');
    await this.incidents.observe({ key: 'jellyfin.monitor', severity: 'ok', message: 'JELLYFIN: API operativa' });
  }

  private async toStoredSession(session: JellyfinSession, previous?: StoredSession): Promise<StoredSession> {
    const ip = remoteIp(session.RemoteEndPoint);
    let location = previous?.location ?? 'ubicacion no disponible';
    if (ip && (!previous || location === 'ubicacion no disponible')) {
      try {
        location = await this.locateIp(ip);
      } catch {
        this.log.warn({}, 'ubicacion Jellyfin no disponible');
      }
    }
    return {
      user: compact(session.UserName ?? 'usuario desconocido', 36),
      device: compact(session.DeviceName ?? 'dispositivo desconocido', 30),
      location: compact(location, 42),
      media: compact(mediaLabel(session.NowPlayingItem), 62),
    };
  }

  private async emitActivity(tag: string, dedupKey: string, message: string): Promise<void> {
    if (this.mode !== 'live') {
      this.state.incrInfo(tag);
      this.log.info({ tag }, 'dry-run: actividad Jellyfin detectada');
      return;
    }
    await this.dispatcher.emit({ level: 'event', tag, message, dedupKey });
  }
}

export function mmdbLocator(command: string, database: string): LocateIp {
  return async (ip: string): Promise<string> => {
    if (!command || !database || !isIP(ip)) return 'ubicacion no disponible';
    const [city, country] = await Promise.all([
      mmdbValue(command, database, ip, ['city', 'names', 'en']),
      mmdbValue(command, database, ip, ['country', 'names', 'en']),
    ]);
    return compact([city, country].filter(Boolean).join(', ') || 'ubicacion no disponible', 42);
  };
}

async function mmdbValue(command: string, database: string, ip: string, path: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, ['--file', database, '--ip', ip, ...path], { timeout: 5_000 });
    return stdout.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/)?.[1]?.replace(/\\"/g, '"') ?? '';
  } catch {
    return '';
  }
}

function remoteIp(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  if (endpoint.startsWith('[')) return endpoint.slice(1, endpoint.indexOf(']')) || undefined;
  const colons = [...endpoint].filter((char) => char === ':').length;
  return colons === 1 ? endpoint.split(':')[0] : endpoint;
}

function mediaLabel(item: JellyfinSession['NowPlayingItem']): string {
  if (!item?.Name) return '';
  const parent = item.SeriesName ?? item.AlbumArtist;
  return parent ? `${parent} - ${item.Name}` : item.Name;
}

function connectionMessage(session: StoredSession): string {
  const media = session.media ? `; reproduce ${session.media}` : '';
  return `JELLYFIN: ${session.user} conectado desde ${session.location} (${session.device})${media}`;
}

function playbackMessage(session: StoredSession): string {
  return `JELLYFIN: ${session.user} reproduce ${session.media} desde ${session.location} (${session.device})`;
}

function decodeSession(raw: string | undefined): StoredSession | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof value.user !== 'string' || typeof value.device !== 'string'
      || typeof value.location !== 'string' || typeof value.media !== 'string') return undefined;
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
