import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

// Periodo de conteo = digest→digest (no medianoche): al enviar el digest se rota.
export interface DayStats {
  day: string; // fecha de inicio del periodo (YYYY-MM-DD local)
  info: Record<string, number>;
  critical: number;
  warning: number;
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
  return { day: localDay(), info: {}, critical: 0, warning: 0 };
}

export class StateStore {
  private path: string;
  data: StateData;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, 'utf8')) as StateData;
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

  addExpectedContainer(name: string): void {
    if (!this.data.expectedContainers.includes(name)) {
      this.data.expectedContainers.push(name);
      this.persist();
    }
  }

  removeExpectedContainer(name: string): void {
    const i = this.data.expectedContainers.indexOf(name);
    if (i >= 0) {
      this.data.expectedContainers.splice(i, 1);
      this.persist();
    }
  }
}
