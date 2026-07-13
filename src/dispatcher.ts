import type { GatewayClient } from './gateway.js';
import type { StateStore } from './state.js';

export type Level = 'critical' | 'warning' | 'info';

export interface AtalayaEvent {
  level: Level;
  /** contador corto para el digest, ej. 'docker.stop' */
  tag: string;
  /** texto del SMS (solo para critical/warning); ASCII para no gastar en UCS-2 */
  message?: string;
  dedupKey?: string;
}

interface Logger {
  info: (obj: object, msg: string) => void;
}

/**
 * Clases de evento → acción:
 *   critical → SMS inmediato (priority critical)
 *   warning  → SMS con dedup_key (priority high; el gateway agrupa "×N")
 *   info     → contador local, va en el digest diario
 */
export class Dispatcher {
  private gateway: GatewayClient;
  private state: StateStore;
  private log: Logger;

  constructor(gateway: GatewayClient, state: StateStore, log: Logger) {
    this.gateway = gateway;
    this.state = state;
    this.log = log;
  }

  async emit(event: AtalayaEvent): Promise<void> {
    this.log.info({ ...event }, 'evento');
    if (event.level === 'info') {
      this.state.incrInfo(event.tag);
      return;
    }
    this.state.incrAlert(event.level);
    await this.gateway.send({
      message: event.message ?? event.tag,
      priority: event.level === 'critical' ? 'critical' : 'high',
      dedupKey: event.dedupKey,
    });
  }
}
