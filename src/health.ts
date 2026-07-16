export type AdapterName = 'docker' | 'pm2' | 'host' | 'vps' | 'canary' | 'backup' | 'smart' | 'gluetun' | 'qbittorrent' | 'jellyfin' | 'aonsoku' | 'aonsoku-logs' | 'navidrome' | 'navidrome-logs';

export interface AdapterHealth {
  connected: boolean;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  reconnects: number;
}

export class HealthRegistry {
  private adapters = new Map<AdapterName, AdapterHealth>();

  constructor(names: AdapterName[] = ['docker', 'pm2']) {
    for (const name of names) this.adapters.set(name, emptyHealth());
  }

  register(name: AdapterName): void {
    this.get(name);
  }

  connected(name: AdapterName): void {
    const health = this.get(name);
    if (health.lastConnectedAt !== null && !health.connected) health.reconnects++;
    health.connected = true;
    health.lastConnectedAt = new Date().toISOString();
    health.lastError = null;
  }

  disconnected(name: AdapterName, error: string): void {
    const health = this.get(name);
    health.connected = false;
    health.lastError = error;
  }

  event(name: AdapterName): void {
    this.get(name).lastEventAt = new Date().toISOString();
  }

  snapshot(): Record<AdapterName, AdapterHealth> {
    return Object.fromEntries(
      [...this.adapters].map(([name, health]) => [name, { ...health }]),
    ) as Record<AdapterName, AdapterHealth>;
  }

  degraded(): AdapterName[] {
    return [...this.adapters].filter(([, health]) => !health.connected).map(([name]) => name);
  }

  private get(name: AdapterName): AdapterHealth {
    let health = this.adapters.get(name);
    if (!health) {
      health = emptyHealth();
      this.adapters.set(name, health);
    }
    return health;
  }
}

function emptyHealth(): AdapterHealth {
  return { connected: false, lastConnectedAt: null, lastEventAt: null, lastError: null, reconnects: 0 };
}
