import type { GatewayClient } from './gateway.js';
import { localDay, type DayStats, type DigestPart, type StateStore } from './state.js';
import type { HealthRegistry } from './health.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface HostDigestData {
  activeIncidents?: number;
  egressDayBytes?: number;
  egressMonthBytes?: number;
  egressUnavailable?: boolean;
}

const CHECK_EVERY_MS = 30_000;
const SMS_MAX_CHARS = 160;

/** Digest diario y heartbeat con snapshot persistente y partes sin truncado. */
export class DigestScheduler {
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(
    private gateway: GatewayClient,
    private state: StateStore,
    private hour: number,
    private log: Logger,
    private now: () => Date = () => new Date(),
    private health?: HealthRegistry,
    private hostDataProvider?: () => Promise<HostDigestData>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.inFlight) return;
    const now = this.now();
    const day = localDay(now);
    let pending = this.state.getPendingDigest();
    if (!pending && (now.getHours() < this.hour || this.state.data.lastDigestDate === day)) return;

    this.inFlight = true;
    try {
      if (!pending) {
        const hostData = this.hostDataProvider ? await this.safeHostData() : undefined;
        pending = this.state.beginDigest(day, this.composeParts(hostData));
      }
      for (const part of pending.parts) {
        if (pending.deliveredPartIds.includes(part.id)) continue;
        const result = await this.gateway.send({
          message: part.message,
          priority: 'normal',
          dedupKey: `atalaya:digest:${pending.day}:${part.id}`,
        });
        if (result.outcome === 'accepted' || result.outcome === 'deduplicated') {
          this.state.markDigestPartDelivered(part.id);
          this.log.info({ id: part.id, message: part.message, outcome: result.outcome }, 'digest aceptado');
        } else {
          this.log.error({ id: part.id }, 'no se pudo enviar parte del digest; se reintentará');
        }
      }
      const updated = this.state.getPendingDigest();
      if (updated && updated.parts.every((part) => updated.deliveredPartIds.includes(part.id))) {
        this.state.completeDigest();
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** Compatibilidad para inspección/tests cuando el digest cabe en una parte. */
  compose(hostData?: HostDigestData): string {
    return this.composeParts(hostData)[0]?.message ?? '';
  }

  composeParts(hostData?: HostDigestData): DigestPart[] {
    const stats = this.state.data.today;
    const now = this.now();
    const date = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const core = coreTokens(stats, this.health);
    const hosts = hostTokens(hostData);
    const combined = render(`Atalaya ${date}:`, [...core, ...hosts]);
    if (combined.length <= SMS_MAX_CHARS) return [{ id: 'main', message: combined }];

    return [
      ...pack(`Atalaya ${date}:`, core, 'core'),
      ...pack(`Hosts ${date}:`, hosts, 'hosts'),
    ].filter((part) => part.message.length > part.message.indexOf(':') + 1);
  }

  private async safeHostData(): Promise<HostDigestData> {
    try {
      return await this.hostDataProvider!();
    } catch (err) {
      this.log.error({ err: String(err) }, 'no se pudo obtener contexto host del digest');
      return { activeIncidents: this.state.activeIncidentCount(), egressUnavailable: true };
    }
  }
}

function coreTokens(stats: DayStats, health?: HealthRegistry): string[] {
  const parts: string[] = [];
  const degraded = health?.degraded() ?? [];
  if (degraded.length) parts.push(`DEGRADADO ${degraded.join('+')}`);
  if (stats.critical > 0) parts.push(`${stats.critical} critico${stats.critical > 1 ? 's' : ''}`);
  if (stats.warning > 0) parts.push(`${stats.warning} aviso${stats.warning > 1 ? 's' : ''}`);
  if (stats.recovery > 0) parts.push(`${stats.recovery} recuperado${stats.recovery > 1 ? 's' : ''}`);
  if (stats.accepted > 0) parts.push(`${stats.accepted} aceptado${stats.accepted > 1 ? 's' : ''}`);
  if (stats.deduplicated > 0) parts.push(`${stats.deduplicated} dedup`);
  if (stats.rejected > 0) parts.push(`${stats.rejected} rechazado${stats.rejected > 1 ? 's' : ''}`);
  parts.push(...Object.entries(stats.info)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => `${tag} x${count}`));
  return parts.length ? parts : ['sin novedades'];
}

function hostTokens(data?: HostDigestData): string[] {
  if (!data) return [];
  const parts: string[] = [];
  if ((data.activeIncidents ?? 0) > 0) parts.push(`hosts ${data.activeIncidents} activos`);
  if (data.egressUnavailable) parts.push('OCI egress sin datos');
  else if (data.egressDayBytes !== undefined && data.egressMonthBytes !== undefined) {
    parts.push(`OCI hoy ${formatBytes(data.egressDayBytes)}, mes ${formatBytes(data.egressMonthBytes)}`);
  }
  return parts;
}

function pack(prefix: string, tokens: string[], idPrefix: string): DigestPart[] {
  if (!tokens.length) return [];
  const parts: DigestPart[] = [];
  let current: string[] = [];
  for (const raw of tokens.flatMap((token) => splitLongToken(toAscii(token), SMS_MAX_CHARS - prefix.length - 2))) {
    const candidate = render(prefix, [...current, raw]);
    if (candidate.length <= SMS_MAX_CHARS) {
      current.push(raw);
      continue;
    }
    parts.push({ id: `${idPrefix}-${parts.length + 1}`, message: render(prefix, current) });
    current = [raw];
  }
  if (current.length) parts.push({ id: `${idPrefix}-${parts.length + 1}`, message: render(prefix, current) });
  return parts;
}

function render(prefix: string, tokens: string[]): string {
  return `${toAscii(prefix)} ${tokens.map(toAscii).join(', ')}`;
}

function splitLongToken(token: string, max: number): string[] {
  if (token.length <= max) return [token];
  const result: string[] = [];
  let rest = token;
  while (rest.length > max) {
    const boundary = rest.lastIndexOf(' ', max);
    const end = boundary > 0 ? boundary : max;
    result.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) result.push(rest);
  return result;
}

function toAscii(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '?');
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1024) return `${(gib / 1024).toFixed(2)}TB`;
  return `${gib.toFixed(gib >= 10 ? 1 : 2)}GB`;
}
