import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

// Periodo de conteo = digest→digest (no medianoche): al enviar el digest se rota.
export interface DayStats {
  day: string; // fecha de inicio del periodo (YYYY-MM-DD local)
  info: Record<string, number>;
  critical: number;
  warning: number;
  accepted: number;
  deduplicated: number;
  rejected: number;
}

interface StateData {
  today: DayStats;
  lastDigestDate: string;
  expectedContainers: string[];
  history: DayStats[];
}

export function localDay(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyDay(): DayStats {
  return {
    day: localDay(), info: {}, critical: 0, warning: 0,
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
        this.data = { today: emptyDay(), lastDigestDate: '', expectedContainers: [], history: [] };
      }
    } else {
      this.data = { today: emptyDay(), lastDigestDate: '', expectedContainers: [], history: [] };
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

  incrAlert(level: 'critical' | 'warning'): void {
    this.data.today[level] += 1;
    this.persist();
  }

  recordGateway(outcome: 'accepted' | 'deduplicated' | 'rejected'): void {
    this.data.today[outcome]++;
    this.persist();
  }

  /** cierra el periodo actual (llamado por el digest tras enviarse) */
  rotate(digestDay: string): void {
    this.data.history.unshift(this.data.today);
    this.data.history = this.data.history.slice(0, 7);
    this.data.today = emptyDay();
    this.data.lastDigestDate = digestDay;
    this.persist();
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
  };
}

function normalizeDay(raw?: Partial<DayStats>): DayStats {
  return {
    day: typeof raw?.day === 'string' ? raw.day : localDay(),
    info: raw?.info && typeof raw.info === 'object' ? raw.info : {},
    critical: Number(raw?.critical ?? 0),
    warning: Number(raw?.warning ?? 0),
    accepted: Number(raw?.accepted ?? 0),
    deduplicated: Number(raw?.deduplicated ?? 0),
    rejected: Number(raw?.rejected ?? 0),
  };
}
