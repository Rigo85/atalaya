import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BackupMonitor } from '../src/adapters/backup-monitor.js';
import { CanaryMonitor } from '../src/adapters/canary.js';
import { HostMonitor, type HostSnapshot, type HostThresholds } from '../src/adapters/host-monitor.js';
import { SmartMonitor, type SmartSnapshot } from '../src/adapters/smart-monitor.js';
import { GluetunMonitor } from '../src/adapters/gluetun-monitor.js';
import { QbittorrentMonitor } from '../src/adapters/qbittorrent-monitor.js';
import { formatGeoLocation, JellyfinMonitor } from '../src/adapters/jellyfin-monitor.js';
import { Dispatcher } from '../src/dispatcher.js';
import { HealthRegistry } from '../src/health.js';
import { IncidentManager } from '../src/incidents.js';
import { fakeGateway, silentLog, tempState } from './helpers.js';

const thresholds: HostThresholds = {
  systemDiskWarningPct: 80,
  systemDiskCriticalPct: 90,
  mediaDiskWarningPct: 90,
  mediaDiskCriticalPct: 97,
  mediaDiskCriticalFreeBytes: 100 * 1024 ** 3,
  inodeWarningPct: 85,
  inodeCriticalPct: 95,
  memoryWarningAvailablePct: 15,
  memoryCriticalAvailablePct: 5,
  cpuWarningPct: 90,
  cpuCriticalPct: 98,
  ioWaitWarningPct: 30,
  ioWaitCriticalPct: 60,
  temperatureWarningC: 80,
  temperatureCriticalC: 90,
};

function setup(mode: 'dry-run' | 'live' = 'live') {
  const state = tempState();
  const gateway = fakeGateway();
  const dispatcher = new Dispatcher(gateway.client, state, silentLog);
  const incidents = new IncidentManager(state, dispatcher, mode, silentLog);
  return { state, sent: gateway.sent, dispatcher, incidents };
}

function healthySnapshot(): HostSnapshot {
  return {
    bootId: 'boot-1', cpuPct: 10, ioWaitPct: 1, memoryAvailablePct: 70,
    swapUsedBytes: 0, swapPagesPerSecond: 0, temperatureC: 40,
    clockSynchronized: true,
    filesystems: [{
      path: '/media/data', present: true, readOnly: false, usedPct: 50,
      freeBytes: 500 * 1024 ** 3, inodeUsedPct: 1,
    }],
  };
}

describe('GeoLite2 location formatting', () => {
  it('incluye ciudad, region, pais y radio sin aparentar precision exacta', () => {
    expect(formatGeoLocation('Lima', 'Lima Province', 'Peru', '20'))
      .toBe('Lima, Lima Province, Peru, radio ~20 km');
  });

  it('omite campos ausentes y no duplica nombres equivalentes', () => {
    expect(formatGeoLocation('Lima', 'lima', 'Peru', '')).toBe('Lima, Peru');
  });
});

describe('IncidentManager', () => {
  it('notifica apertura, escalamiento y recuperación sin repetir', async () => {
    const { incidents, sent, state } = setup();
    await incidents.observe({ key: 'x', severity: 'warning', message: 'X warning' });
    await incidents.observe({ key: 'x', severity: 'warning', message: 'X warning' });
    await incidents.observe({ key: 'x', severity: 'critical', message: 'X critical' });
    expect(sent.map((item) => item.priority)).toEqual(['high', 'critical']);
    expect(sent[0]?.dedupKey).not.toBe(sent[1]?.dedupKey);

    await incidents.observe({ key: 'x', severity: 'ok', message: 'X normal' });
    expect(state.getIncident('x')).toBeDefined();
    await incidents.observe({ key: 'x', severity: 'ok', message: 'X normal' });
    expect(state.getIncident('x')).toBeUndefined();
    expect(sent[2]).toMatchObject({ priority: 'high' });
    expect(sent[2]?.message).toContain('RECUPERADO');
  });

  it('dry-run conserva estado sin enviar', async () => {
    const { incidents, sent, state } = setup('dry-run');
    await incidents.observe({ key: 'x', severity: 'critical', message: 'X' });
    expect(sent).toHaveLength(0);
    expect(state.getIncident('x')?.notified).toBe(false);
  });
});

describe('HostMonitor', () => {
  it('aplica umbral de disco y recuperación en dos lecturas', async () => {
    const { dispatcher, incidents, sent, state } = setup();
    const health = new HealthRegistry();
    let snapshot = healthySnapshot();
    const monitor = new HostMonitor(
      'local', 'host', async () => snapshot, new Set(), new Set(['/media/data']), thresholds,
      60_000, incidents, state, health, silentLog,
    );
    await monitor.tick();
    snapshot = { ...snapshot, filesystems: [{ ...snapshot.filesystems[0]!, usedPct: 91 }] };
    await monitor.tick();
    expect(sent[0]?.message).toContain('91% usado');
    snapshot = healthySnapshot();
    await monitor.tick();
    await monitor.tick();
    expect(sent.at(-1)?.message).toContain('RECUPERADO');
  });

  it('exige duración sostenida para RAM', async () => {
    const { incidents, sent, state } = setup();
    const health = new HealthRegistry();
    let now = 0;
    const snapshot = { ...healthySnapshot(), memoryAvailablePct: 10 };
    const monitor = new HostMonitor(
      'local', 'host', async () => snapshot, new Set(), new Set(['/media/data']), thresholds,
      60_000, incidents, state, health, silentLog, () => now,
    );
    await monitor.tick();
    now = 9 * 60_000;
    await monitor.tick();
    expect(sent).toHaveLength(0);
    now = 10 * 60_000;
    await monitor.tick();
    expect(sent[0]?.message).toContain('RAM disponible 10.0%');
  });
});

describe('CanaryMonitor', () => {
  it('agrupa fallos simultáneos y escala una sola alerta', async () => {
    const { incidents, sent } = setup();
    const health = new HealthRegistry();
    let ok = false;
    const fetchFn = vi.fn(async () => new Response('', { status: ok ? 200 : 500 })) as typeof fetch;
    const targets = ['a', 'b', 'c'].map((name) => ({ name, url: `https://${name}.example/`, expectedStatus: 200 }));
    const monitor = new CanaryMonitor({
      targets, edgeIntervalMs: 60_000, targetIntervalMs: 300_000,
      certificateIntervalMs: 86_400_000, certificateWarningDays: 14, certificateCriticalDays: 5,
    }, incidents, health, silentLog, fetchFn);
    await monitor.checkTargets();
    await monitor.checkTargets();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toContain('3/3 dominios');
    await monitor.checkTargets();
    await monitor.checkTargets();
    await monitor.checkTargets();
    expect(sent.filter((item) => item.priority === 'critical')).toHaveLength(1);
    ok = true;
    await monitor.checkTargets();
    await monitor.checkTargets();
    expect(sent.at(-1)?.message).toContain('RECUPERADO');
  });
});

describe('BackupMonitor', () => {
  it('detecta retención vencida y recupera tras limpiarla', async () => {
    const { incidents, sent } = setup();
    const health = new HealthRegistry();
    const dir = mkdtempSync(join(tmpdir(), 'atalaya-backup-'));
    mkdirSync(dir, { recursive: true });
    const current = join(dir, 'books-store_2026-07-14-18-40-01.sql.gz');
    const old = join(dir, 'books-store_2026-05-01-00-00-00.sql.gz');
    writeFileSync(current, 'ok');
    writeFileSync(old, 'old');
    const now = new Date('2026-07-14T21:00:00Z').getTime();
    utimesSync(current, new Date(now - 60_000), new Date(now - 60_000));
    utimesSync(old, new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000));
    const monitor = new BackupMonitor(dir, 1_800_000, incidents, health, silentLog, () => now, async () => {});
    await monitor.tick();
    expect(sent[0]?.message).toContain('1 vencidos');
    rmSync(old);
    await monitor.tick();
    await monitor.tick();
    expect(sent.at(-1)?.message).toContain('RECUPERADO');
  });
});

describe('SmartMonitor', () => {
  it('usa baseline para alertar solo incrementos y fallos actuales', async () => {
    const { incidents, sent, state } = setup();
    const health = new HealthRegistry();
    let snapshot: SmartSnapshot = {
      disks: [{ id: 'disk-1', passed: true, temperatureC: 35, reallocated: 2, pending: 0, offlineUncorrectable: 0, crcErrors: 1 }],
      pools: [{ name: 'pool', health: 'ONLINE' }],
    };
    const monitor = new SmartMonitor('', 1_000_000, incidents, state, health, silentLog, async () => snapshot);
    await monitor.tick();
    expect(sent).toHaveLength(0);
    snapshot = {
      disks: [{ ...snapshot.disks[0]!, reallocated: 3, pending: 1 }],
      pools: [{ name: 'pool', health: 'DEGRADED' }],
    };
    await monitor.tick();
    expect(sent.some((item) => item.message.includes('reasignados +1'))).toBe(true);
    expect(sent.filter((item) => item.priority === 'critical')).toHaveLength(2);
  });
});

describe('GluetunMonitor', () => {
  it('alerta si la VPN no está operativa, recupera y solo cuenta cambios de salida', async () => {
    const { incidents, sent, state } = setup();
    const health = new HealthRegistry();
    let status = 'running';
    let publicIp = '198.51.100.10';
    const fetchFn = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/v1/vpn/status')) return Response.json({ status });
      return Response.json({ public_ip: publicIp, city: 'Example City', country: 'Example' });
    }) as typeof fetch;
    const monitor = new GluetunMonitor({
      dockerSocket: '/docker.sock', container: 'gluetun', controlPort: 8000, apiKey: 'test', intervalMs: 60_000,
    }, incidents, state, health, silentLog, async () => 'http://172.20.0.2:8000', fetchFn);

    await monitor.tick();
    expect(sent).toHaveLength(0);
    expect(state.getServiceBaseline('gluetun.public-ip')).toBe(publicIp);

    status = 'stopped';
    await monitor.tick();
    expect(sent[0]?.message).toContain('VPN no operativo');
    expect(sent[0]?.message).not.toContain(publicIp);

    status = 'running';
    await monitor.tick();
    await monitor.tick();
    expect(sent.at(-1)?.message).toContain('RECUPERADO');

    publicIp = '198.51.100.11';
    await monitor.tick();
    expect(state.data.today.info['gluetun.public-ip-change']).toBe(1);
    expect(sent.at(-1)?.message).not.toContain(publicIp);
    expect(health.snapshot().gluetun.connected).toBe(true);
  });
});

describe('QbittorrentMonitor', () => {
  it('usa el baseline inicial, cuenta altas/finalizaciones y abre errores sin rutas', async () => {
    const { dispatcher, incidents, sent, state } = setup();
    const health = new HealthRegistry();
    let round = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith('/api/v2/auth/login')) {
        return new Response('Ok.', { headers: { 'set-cookie': 'SID=test; HttpOnly' } });
      }
      round++;
      if (round === 1) return Response.json({
        rid: 1, full_update: true,
        torrents: { a: { name: 'inicial', state: 'downloading', completion_on: 0 } },
      });
      if (round === 2) return Response.json({
        rid: 2, full_update: false,
        torrents: {
          a: { completion_on: 1 },
          b: { name: 'documento privado', state: 'error', completion_on: 0 },
        },
      });
      return Response.json({ rid: 3, full_update: false, torrents: { b: { state: 'downloading' } } });
    }) as typeof fetch;
    const monitor = new QbittorrentMonitor({
      url: 'http://qbit.test', username: 'monitor', password: 'x', intervalMs: 60_000,
    }, dispatcher, incidents, state, health, silentLog, fetchFn);

    await monitor.tick();
    expect(sent).toHaveLength(0);
    expect(state.data.today.info['qbit.download-new']).toBeUndefined();

    await monitor.tick();
    expect(state.data.today.info['qbit.download-new']).toBe(1);
    expect(state.data.today.info['qbit.download-complete']).toBe(1);
    expect(sent[0]).toMatchObject({ priority: 'normal' });
    expect(sent[0]?.message).toContain('descarga finalizada');
    expect(sent[0]?.message).toContain('inicial');
    expect(sent[0]?.dedupKey).toMatch(/^qbit:complete:[a-f0-9]{16}$/);
    expect(sent[1]?.message).toContain('descarga con error');
    expect(sent[1]?.message).toContain('documento privado');
    expect(sent[1]?.message).not.toContain('/');

    await monitor.tick();
    await monitor.tick();
    expect(sent.at(-1)?.message).toContain('RECUPERADO');
    expect(health.snapshot().qbittorrent.connected).toBe(true);
  });
});

describe('JellyfinMonitor', () => {
  it('no notifica el baseline y envía conexiones/reproducción sin IP completa', async () => {
    const { incidents, state } = setup();
    const events = fakeGateway();
    const dispatcher = new Dispatcher(events.client, state, silentLog);
    const health = new HealthRegistry();
    let round = 0;
    const fetchFn = vi.fn(async () => {
      round++;
      if (round === 1) return Response.json([{
        Id: 's1', UserName: 'Ana', DeviceName: 'TV', RemoteEndPoint: '198.51.100.15:8096:extra',
      }]);
      if (round === 2) return Response.json([{
        Id: 's1', UserName: 'Ana', DeviceName: 'TV', RemoteEndPoint: '198.51.100.15:8096:extra',
        NowPlayingItem: { SeriesName: 'Serie', Name: 'Episodio 1' },
      }]);
      return Response.json([
        {
          Id: 's1', UserName: 'Ana', DeviceName: 'TV', RemoteEndPoint: '198.51.100.15:8096:extra',
          NowPlayingItem: { SeriesName: 'Serie', Name: 'Episodio 1' },
        },
        {
          Id: 's2', UserName: 'Beto', DeviceName: 'Web', RemoteEndPoint: '203.0.113.16:443',
          NowPlayingItem: { Name: 'Pelicula' },
        },
      ]);
    }) as typeof fetch;
    const located: string[] = [];
    const monitor = new JellyfinMonitor({ url: 'http://jellyfin.test', apiKey: 'key', intervalMs: 60_000 },
      'live', dispatcher, incidents, state, health, silentLog, fetchFn, async (ip) => {
        located.push(ip);
        return 'Lima, Peru';
      });

    await monitor.tick();
    expect(events.sent).toHaveLength(0);
    expect(state.data.today.info['jellyfin.session-new']).toBeUndefined();

    await monitor.tick();
    expect(events.sent[0]).toMatchObject({ priority: 'normal' });
    expect(events.sent[0]?.message).toContain('Ana reproduce Serie - Episodio 1');
    expect(events.sent[0]?.message).not.toContain('198.51.100.15');

    await monitor.tick();
    expect(events.sent[1]?.message).toContain('Beto conectado desde Lima, Peru');
    expect(events.sent[1]?.message).toContain('reproduce Pelicula');
    expect(events.sent[1]?.message).not.toContain('203.0.113.16');
    expect(state.data.today.info['jellyfin.playback-start']).toBe(1);
    expect(state.data.today.info['jellyfin.session-new']).toBe(1);
    expect(located).toEqual(['198.51.100.15', '203.0.113.16']);
    expect(health.snapshot().jellyfin.connected).toBe(true);
  });

  it('identifica sesiones privadas como red local sin consultarlas en GeoIP', async () => {
    const { incidents, state } = setup();
    const events = fakeGateway();
    const dispatcher = new Dispatcher(events.client, state, silentLog);
    const located: string[] = [];
    const monitor = new JellyfinMonitor({ url: 'http://jellyfin.test', apiKey: 'key', intervalMs: 60_000 },
      'live', dispatcher, incidents, state, new HealthRegistry(), silentLog,
      (async () => Response.json([{ Id: 's1', UserName: 'Ana', DeviceName: 'TV', RemoteEndPoint: '192.168.1.20:8096' }])) as typeof fetch,
      async (ip) => { located.push(ip); return 'no deberia usarse'; });

    await monitor.tick();
    state.removeServiceBaseline('jellyfin.session.s1');
    await monitor.tick();

    expect(events.sent[0]?.message).toContain('red local');
    expect(located).toHaveLength(0);
  });

  it('vuelve a resolver GeoIP cuando una sesion pasa de red local a publica', async () => {
    const { incidents, state } = setup();
    const events = fakeGateway();
    const dispatcher = new Dispatcher(events.client, state, silentLog);
    let endpoint = '192.168.1.20:8096';
    const located: string[] = [];
    const monitor = new JellyfinMonitor({ url: 'http://jellyfin.test', apiKey: 'key', intervalMs: 60_000 },
      'live', dispatcher, incidents, state, new HealthRegistry(), silentLog,
      (async () => Response.json([{ Id: 's1', UserName: 'Ana', DeviceName: 'TV', RemoteEndPoint: endpoint }])) as typeof fetch,
      async (ip) => { located.push(ip); return 'Santiago, Chile'; });

    await monitor.tick();
    endpoint = '198.51.100.20:8096';
    await monitor.tick();

    expect(located).toEqual(['198.51.100.20']);
  });
});
