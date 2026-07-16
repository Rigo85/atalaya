import type { Dispatcher } from './dispatcher.js';
import type { ActiveIncident, StateStore } from './state.js';

export type IncidentSeverity = 'ok' | 'warning' | 'critical';
export type MonitorMode = 'off' | 'dry-run' | 'live';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface IncidentObservation {
  key: string;
  severity: IncidentSeverity;
  message: string;
}

const RETRY_NOTIFICATION_MS = 15 * 60_000;

export class IncidentManager {
  constructor(
    private state: StateStore,
    private dispatcher: Dispatcher,
    private mode: MonitorMode,
    private log: Logger,
    private now: () => Date = () => new Date(),
  ) {}

  async observe(observation: IncidentObservation): Promise<void> {
    if (this.mode === 'off') return;
    const existing = this.state.getIncident(observation.key);
    if (observation.severity === 'ok') {
      await this.observeHealthy(observation, existing);
      return;
    }

    const nowIso = this.now().toISOString();
    const escalated = existing?.severity === 'warning' && observation.severity === 'critical';
    const changed = !existing || escalated || existing.message !== observation.message;
    const incident: ActiveIncident = existing && !escalated
      ? { ...existing, updatedAt: nowIso, message: observation.message, healthyObservations: 0 }
      : {
          key: observation.key,
          severity: observation.severity,
          openedAt: existing?.openedAt ?? nowIso,
          updatedAt: nowIso,
          message: observation.message,
          notified: false,
          lastNotificationAttemptAt: null,
          healthyObservations: 0,
        };
    if (escalated) incident.severity = 'critical';
    this.state.setIncident(incident);

    if (this.mode === 'dry-run') {
      if (changed) this.log.warn({ ...observation }, 'dry-run: incidente detectado');
      return;
    }
    if (!shouldNotify(incident, this.now())) return;

    incident.lastNotificationAttemptAt = nowIso;
    this.state.setIncident(incident);
    const result = await this.dispatcher.emit({
      level: incident.severity,
      tag: `incident.${incident.key}`,
      message: incident.message,
      dedupKey: `incident:${incident.key}:${incident.severity}:${incident.openedAt}`,
    });
    if (result === 'accepted' || result === 'deduplicated') {
      incident.notified = true;
      this.state.setIncident(incident);
    }
  }

  private async observeHealthy(
    observation: IncidentObservation,
    existing: ActiveIncident | undefined,
  ): Promise<void> {
    if (!existing) return;
    existing.healthyObservations += 1;
    existing.updatedAt = this.now().toISOString();
    this.state.setIncident(existing);
    if (existing.healthyObservations < 2) return;

    this.state.removeIncident(existing.key);
    if (this.mode !== 'live' || !existing.notified) {
      this.log.info({ key: existing.key }, 'incidente recuperado sin SMS previo');
      return;
    }

    const duration = formatDuration(this.now().getTime() - Date.parse(existing.openedAt));
    await this.dispatcher.emit({
      level: 'recovery',
      tag: `recovery.${existing.key}`,
      message: `RECUPERADO: ${observation.message} tras ${duration}`,
      dedupKey: `recovery:${existing.key}:${existing.openedAt}`,
    });
  }
}

function shouldNotify(incident: ActiveIncident, now: Date): boolean {
  if (incident.notified) return false;
  if (!incident.lastNotificationAttemptAt) return true;
  return now.getTime() - Date.parse(incident.lastNotificationAttemptAt) >= RETRY_NOTIFICATION_MS;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
}
