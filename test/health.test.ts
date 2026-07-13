import { describe, expect, it } from 'vitest';
import { HealthRegistry } from '../src/health.js';

describe('HealthRegistry', () => {
  it('registra conexión, evento, caída y reconexión', () => {
    const health = new HealthRegistry();
    expect(health.degraded()).toEqual(['docker', 'pm2']);
    health.connected('docker');
    health.event('docker');
    health.disconnected('docker', 'stream cerrado');
    health.connected('docker');
    const docker = health.snapshot().docker;
    expect(docker.connected).toBe(true);
    expect(docker.lastConnectedAt).not.toBeNull();
    expect(docker.lastEventAt).not.toBeNull();
    expect(docker.lastError).toBeNull();
    expect(docker.reconnects).toBe(1);
  });
});
