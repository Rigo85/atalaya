import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

// Periodo de conteo = digest→digest (no medianoche): al enviar el digest se rota.
export interface DayStats {
  day: string; // fecha de inicio del periodo (YYYY-MM-DD local)
  info: Record<string, number>;
  critical: number;
  warning: number;
  recovery: number;
  accepted: number;
  deduplicated: number;
  rejected: number;
}

export interface ActiveIncident {
  key: string;
  severity: 'warning' | 'critical';
  openedAt: string;
  updatedAt: string;
  message: string;
  notified: boolean;
  lastNotificationAttemptAt: string | null;
  healthyObservations: number;
}

export interface DigestPart {
  id: string;
  message: string;
}

interface PendingDigest {
  day: string;
  stats: DayStats;
  parts: DigestPart[];
  deliveredPartIds: string[];
}

interface SmartBaseline {
  reallocated: number;
  pending: number;
  offlineUncorrectable: number;
  crcErrors: number;
}

interface StateData {
  today: DayStats;
  lastDigestDate: string;
  expectedContainers: string[];
  history: DayStats[];
  activeIncidents: Record<string, ActiveIncident>;
  lastBootIds: Record<string, string>;
  smartBaselines: Record<string, SmartBaseline>;
  serviceBaselines: Record<string, string>;
  pendingDigest: PendingDigest | null;
}

export function localDay(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyDay(): DayStats {
  return {
    day: localDay(), info: {}, critical: 0, warning: 0, recovery: 0,
    accepted: 0, deduplicated: 0, rejected: 0,
  };
}

export class StateStore {
  private path: string;
  data: StateData;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      try {
        this.data = normalizeState(JSON.parse(readFileSync(path, 'utf8')) as Partial<StateData>);
      } catch {
        this.data = emptyState();
      }
    } else {
      this.data = emptyState();
    }
  }

  private persist(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  incrInfo(tag: string): void {
    this.data.today.info[tag] = (this.data.today.info[tag] ?? 0) + 1;
    this.persist();
  }

  incrInfoBy(tag: string, count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    this.data.today.info[tag] = (this.data.today.info[tag] ?? 0) + Math.floor(count);
    this.persist();
  }

  incrAlert(level: 'critical' | 'warning' | 'recovery'): void {
    this.data.today[level] += 1;
    this.persist();
  }

  recordGateway(outcome: 'accepted' | 'deduplicated' | 'rejected'): void {
    this.data.today[outcome]++;
    this.persist();
  }

  beginDigest(day: string, parts: DigestPart[]): PendingDigest {
    if (this.data.pendingDigest) return this.data.pendingDigest;
    const stats = this.data.today;
    this.data.pendingDigest = { day, stats, parts, deliveredPartIds: [] };
    this.data.today = emptyDay();
    this.persist();
    return this.data.pendingDigest;
  }

  markDigestPartDelivered(id: string): void {
    const pending = this.data.pendingDigest;
    if (!pending || pending.deliveredPartIds.includes(id)) return;
    pending.deliveredPartIds.push(id);
    this.persist();
  }

  completeDigest(): void {
    const pending = this.data.pendingDigest;
    if (!pending) return;
    this.data.history.unshift(pending.stats);
    this.data.history = this.data.history.slice(0, 7);
    this.data.lastDigestDate = pending.day;
    this.data.pendingDigest = null;
    this.persist();
  }

  getPendingDigest(): PendingDigest | null {
    return this.data.pendingDigest;
  }

  getIncident(key: string): ActiveIncident | undefined {
    return this.data.activeIncidents[key];
  }

  setIncident(incident: ActiveIncident): void {
    this.data.activeIncidents[incident.key] = incident;
    this.persist();
  }

  removeIncident(key: string): void {
    if (!(key in this.data.activeIncidents)) return;
    delete this.data.activeIncidents[key];
    this.persist();
  }

  activeIncidentCount(): number {
    return Object.keys(this.data.activeIncidents).length;
  }

  getLastBootId(host: string): string | undefined {
    return this.data.lastBootIds[host];
  }

  setLastBootId(host: string, bootId: string): void {
    this.data.lastBootIds[host] = bootId;
    this.persist();
  }

  getSmartBaseline(disk: string): SmartBaseline | undefined {
    return this.data.smartBaselines[disk];
  }

  setSmartBaseline(disk: string, baseline: SmartBaseline): void {
    this.data.smartBaselines[disk] = baseline;
    this.persist();
  }

  getServiceBaseline(key: string): string | undefined {
    return this.data.serviceBaselines[key];
  }

  setServiceBaseline(key: string, value: string): void {
    this.data.serviceBaselines[key] = value;
    this.persist();
  }

  removeServiceBaseline(key: string): void {
    if (!(key in this.data.serviceBaselines)) return;
    delete this.data.serviceBaselines[key];
    this.persist();
  }

  serviceBaselineEntries(prefix: string): Array<[string, string]> {
    return Object.entries(this.data.serviceBaselines).filter(([key]) => key.startsWith(prefix));
  }

  setExpectedContainers(names: string[]): void {
    this.data.expectedContainers = [...new Set(names)].sort();
    this.persist();
  }

  addExpectedContainer(name: string): boolean {
    if (!this.data.expectedContainers.includes(name)) {
      this.data.expectedContainers.push(name);
      this.data.expectedContainers.sort();
      this.persist();
      return true;
    }
    return false;
  }

  removeExpectedContainer(name: string): boolean {
    const i = this.data.expectedContainers.indexOf(name);
    if (i >= 0) {
      this.data.expectedContainers.splice(i, 1);
      this.persist();
      return true;
    }
    return false;
  }
}

function normalizeState(raw: Partial<StateData>): StateData {
  return {
    today: normalizeDay(raw.today),
    lastDigestDate: typeof raw.lastDigestDate === 'string' ? raw.lastDigestDate : '',
    expectedContainers: Array.isArray(raw.expectedContainers)
      ? [...new Set(raw.expectedContainers.filter((name): name is string => typeof name === 'string'))].sort()
      : [],
    history: Array.isArray(raw.history) ? raw.history.map(normalizeDay) : [],
    activeIncidents: normalizeIncidents(raw.activeIncidents),
    lastBootIds: normalizeStringMap(raw.lastBootIds),
    smartBaselines: normalizeSmartBaselines(raw.smartBaselines),
    serviceBaselines: normalizeStringMap(raw.serviceBaselines),
    pendingDigest: normalizePendingDigest(raw.pendingDigest),
  };
}

function normalizeDay(raw?: Partial<DayStats>): DayStats {
  return {
    day: typeof raw?.day === 'string' ? raw.day : localDay(),
    info: raw?.info && typeof raw.info === 'object' ? raw.info : {},
    critical: Number(raw?.critical ?? 0),
    warning: Number(raw?.warning ?? 0),
    recovery: Number(raw?.recovery ?? 0),
    accepted: Number(raw?.accepted ?? 0),
    deduplicated: Number(raw?.deduplicated ?? 0),
    rejected: Number(raw?.rejected ?? 0),
  };
}

function emptyState(): StateData {
  return {
    today: emptyDay(), lastDigestDate: '', expectedContainers: [], history: [],
    activeIncidents: {}, lastBootIds: {}, smartBaselines: {}, serviceBaselines: {}, pendingDigest: null,
  };
}

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string'));
}

function normalizeIncidents(raw: unknown): Record<string, ActiveIncident> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, ActiveIncident> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Partial<ActiveIncident>;
    if (v.severity !== 'warning' && v.severity !== 'critical') continue;
    result[key] = {
      key,
      severity: v.severity,
      openedAt: typeof v.openedAt === 'string' ? v.openedAt : new Date().toISOString(),
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : new Date().toISOString(),
      message: typeof v.message === 'string' ? v.message : key,
      notified: Boolean(v.notified),
      lastNotificationAttemptAt: typeof v.lastNotificationAttemptAt === 'string'
        ? v.lastNotificationAttemptAt : null,
      healthyObservations: Number(v.healthyObservations ?? 0),
    };
  }
  return result;
}

function normalizeSmartBaselines(raw: unknown): Record<string, SmartBaseline> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, SmartBaseline> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Partial<SmartBaseline>;
    result[key] = {
      reallocated: Number(v.reallocated ?? 0),
      pending: Number(v.pending ?? 0),
      offlineUncorrectable: Number(v.offlineUncorrectable ?? 0),
      crcErrors: Number(v.crcErrors ?? 0),
    };
  }
  return result;
}

function normalizePendingDigest(raw: unknown): PendingDigest | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<PendingDigest>;
  if (typeof v.day !== 'string' || !Array.isArray(v.parts)) return null;
  const parts = v.parts.filter((part): part is DigestPart => Boolean(part) &&
    typeof part.id === 'string' && typeof part.message === 'string');
  if (parts.length === 0) return null;
  return {
    day: v.day,
    stats: normalizeDay(v.stats),
    parts,
    deliveredPartIds: Array.isArray(v.deliveredPartIds)
      ? v.deliveredPartIds.filter((id): id is string => typeof id === 'string') : [],
  };
}
