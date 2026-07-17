import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerWatcher, type DockerEventMsg } from '../src/adapters/docker-events.js';
import { Pm2Watcher, type Pm2Like } from '../src/adapters/pm2-bus.js';
import { StaticWebMonitor } from '../src/adapters/static-web-monitor.js';
import { ContainerLogMonitor, aonsokuLogError, navidromeLogError } from '../src/adapters/container-log-monitor.js';
import { activityFailureReason, NavidromeMonitor } from '../src/adapters/navidrome-monitor.js';
import { HealthRegistry } from '../src/health.js';
import { IncidentManager } from '../src/incidents.js';
import { makeDispatcher, silentLog } from './helpers.js';

function dockerEvent(name: string, action: string, exitCode?: number): DockerEventMsg {
  return {
    Type: 'container',
    Action: action,
    Actor: { Attributes: { name, ...(exitCode !== undefined ? { exitCode: String(exitCode) } : {}) } },
  };
}

describe('DockerWatcher (reglas)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeWatcher() {
    const ctx = makeDispatcher();
    const watcher = new DockerWatcher(
      ctx.dispatcher,
      ctx.state,
      { sockPath: '/dev/null', downGraceMs: 90_000, ignore: ['buildx'] },
      silentLog,
    );
    return { watcher, ...ctx };
  }

  it('die exit!=0 sin volver → critical tras la gracia', async () => {
    const { watcher, sent } = makeWatcher();
    watcher.handleEvent(dockerEvent('nextcloud', 'die', 137));
    expect(sent).toHaveLength(0); // aún en gracia
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ priority: 'critical' });
    expect(sent[0]?.message).toContain('nextcloud caido (exit 137)');
  });

  it('die exit!=0 y vuelve dentro de la gracia → warning agrupada', async () => {
    const { watcher, sent } = makeWatcher();
    watcher.handleEvent(dockerEvent('mi-redis', 'die', 1));
    await vi.advanceTimersByTimeAsync(30_000);
    watcher.handleEvent(dockerEvent('mi-redis', 'start'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ priority: 'high', dedupKey: 'docker:restart:mi-redis' });
  });

  it('stop ordenado (exit 0) → sin SMS, cuenta en digest y conserva el inventario', async () => {
    const { watcher, sent, state } = makeWatcher();
    state.addExpectedContainer('it-tools');
    watcher.handleEvent(dockerEvent('it-tools', 'die', 0));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(0);
    expect(state.data.today.info['docker.stop']).toBe(1);
    expect(state.data.expectedContainers).toContain('it-tools');
  });

  it('oom → critical directo; unhealthy → warning; ignorados no reportan', async () => {
    const { watcher, sent } = makeWatcher();
    watcher.handleEvent(dockerEvent('jellyfin', 'oom'));
    watcher.handleEvent(dockerEvent('navidrome', 'health_status: unhealthy'));
    watcher.handleEvent(dockerEvent('algo-buildx-tmp', 'die', 137));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.message).toContain('OOM');
    expect(sent[1]).toMatchObject({ dedupKey: 'docker:unhealthy:navidrome' });
  });
});

describe('Pm2Watcher (reglas)', () => {
  function makeWatcher(nowRef: { t: number }) {
    const ctx = makeDispatcher();
    const watcher = new Pm2Watcher(
      ctx.dispatcher,
      { stormCount: 3, stormWindowMs: 600_000, selfName: 'atalaya' },
      silentLog,
      () => nowRef.t,
    );
    return { watcher, ...ctx };
  }

  it('restart suelto y tormenta → critical, con una sola alerta de tormenta', async () => {
    const now = { t: 1_000_000 };
    const { watcher, sent } = makeWatcher(now);
    await watcher.handleEvent({ event: 'restart', process: { name: 'neutron' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ priority: 'critical', dedupKey: 'pm2:restart:neutron' });

    now.t += 60_000;
    await watcher.handleEvent({ event: 'restart', process: { name: 'neutron' } });
    now.t += 60_000;
    await watcher.handleEvent({ event: 'restart', process: { name: 'neutron' } });
    now.t += 1_000;
    await watcher.handleEvent({ event: 'restart', process: { name: 'neutron' } });

    const restarts = sent.filter((s) => s.dedupKey === 'pm2:restart:neutron');
    const storms = sent.filter((s) => s.dedupKey === 'pm2:storm:neutron');
    expect(restarts).toHaveLength(2);
    expect(restarts.every((item) => item.priority === 'critical')).toBe(true);
    expect(storms).toHaveLength(1);
    expect(storms[0]?.message).toContain('bucle de reinicios');
  });

  it('errored / restart overlimit → critical', async () => {
    const now = { t: 1 };
    const { watcher, sent } = makeWatcher(now);
    await watcher.handleEvent({ event: 'restart overlimit', process: { name: 'senet' } });
    expect(sent[0]).toMatchObject({ priority: 'critical', dedupKey: 'pm2:errored:senet' });
  });

  it('se ignora a sí mismo y los stop van al digest', async () => {
    const now = { t: 1 };
    const { watcher, sent, state } = makeWatcher(now);
    await watcher.handleEvent({ event: 'restart', process: { name: 'atalaya' } });
    await watcher.handleEvent({ event: 'stop', process: { name: 'tablut' } });
    expect(sent).toHaveLength(0);
    expect(state.data.today.info['pm2.stop']).toBe(1);
  });

  it('registra conexión, eventos, reconexión y libera listeners al parar', () => {
    const ctx = makeDispatcher();
    const health = new HealthRegistry();
    const bus = new EventEmitter();
    const socket = new EventEmitter();
    const disconnect = vi.fn();
    const pm2: Pm2Like = {
      connect: (callback) => callback(),
      launchBus: (callback) => callback(undefined, bus, socket),
      disconnect,
    };
    const watcher = new Pm2Watcher(
      ctx.dispatcher,
      { stormCount: 3, stormWindowMs: 600_000, selfName: 'atalaya' },
      silentLog,
      Date.now,
      health,
      () => pm2,
    );
    watcher.start();
    expect(health.snapshot().pm2.connected).toBe(true);
    bus.emit('process:event', { event: 'online', process: { name: 'x' } });
    expect(health.snapshot().pm2.lastEventAt).not.toBeNull();
    socket.emit('close');
    expect(health.snapshot().pm2.connected).toBe(false);
    socket.emit('connect');
    expect(health.snapshot().pm2).toMatchObject({ connected: true, reconnects: 1 });
    watcher.stop();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(bus.listenerCount('process:event')).toBe(0);
  });
});

describe('StaticWebMonitor', () => {
  it('comprueba inicio y configuracion; avisa tras dos fallos', async () => {
    const { dispatcher, sent, state } = makeDispatcher();
    const incidents = new IncidentManager(state, dispatcher, 'live', silentLog);
    let failing = false;
    const fetchFn = vi.fn(async (url: URL | string) => {
      if (failing && String(url).endsWith('env-config.js')) return new Response('', { status: 503 });
      const html = String(url).endsWith('env-config.js') ? 'window.env={}' : '<html></html>';
      return new Response(html, { status: 200, headers: { 'content-type': String(url).endsWith('.js') ? 'application/javascript' : 'text/html' } });
    }) as typeof fetch;
    const monitor = new StaticWebMonitor(
      { name: 'aonsoku', url: 'http://aonsoku.test', requiredPaths: ['/', '/env-config.js'], intervalMs: 60_000 },
      incidents, new HealthRegistry(), silentLog, fetchFn,
    );

    await monitor.tick();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    failing = true;
    await monitor.tick();
    expect(sent).toHaveLength(0);
    await monitor.tick();
    expect(sent[0]).toMatchObject({ priority: 'high' });
    expect(sent[0]?.message).toContain('AONSOKU');
  });
});

describe('ContainerLogMonitor', () => {
  it('usa baseline sin SMS y avisa solo cuando el umbral se supera', async () => {
    const { dispatcher, sent, state } = makeDispatcher();
    const now = { value: new Date('2026-07-15T10:00:00Z') };
    const incidents = new IncidentManager(state, dispatcher, 'live', silentLog, () => now.value);
    let lines = ['2026-07-15T09:59:59Z level=warn error=40'];
    const monitor = new ContainerLogMonitor({
      container: 'navidrome', adapter: 'navidrome-logs', stateKey: 'test.logs.cursor', tag: 'navidrome',
      incidentKey: 'navidrome.logs', serviceLabel: 'NAVIDROME', intervalMs: 60_000,
      errorThreshold: 3, matchesError: navidromeLogError,
    }, incidents, state, new HealthRegistry(), silentLog, async () => lines, () => now.value);

    await monitor.tick();
    expect(sent).toHaveLength(0);
    expect(state.data.today.info['navidrome.log-baseline']).toBe(1);

    now.value = new Date('2026-07-15T10:01:00Z');
    lines = ['level=error msg=x', 'level=warn error=40', 'panic: x'];
    await monitor.tick();
    expect(sent[0]).toMatchObject({ priority: 'high' });
    expect(sent[0]?.message).toContain('3 errores');
    expect(aonsokuLogError('x 502 y')).toBe(true);
    expect(aonsokuLogError('x 404 y')).toBe(false);
  });
});

describe('NavidromeMonitor', () => {
  it('clasifica fallos de actividad sin exponer detalles sensibles', () => {
    expect(activityFailureReason(new DOMException('timed out', 'TimeoutError'))).toBe('timeout');
    expect(activityFailureReason(new TypeError('fetch failed'))).toBe('network');
    expect(activityFailureReason(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe('network_econnreset');
    expect(activityFailureReason(new SyntaxError('Unexpected token'))).toBe('invalid_json');
  });

  it.each([
    ['http_503', () => new Response('unavailable', { status: 503 })],
    ['subsonic_rejected', () => new Response(JSON.stringify({ 'subsonic-response': { status: 'failed' } }), { status: 200 })],
  ])('registra %s sin incluir la respuesta de actividad', async (reason, response) => {
    const { dispatcher, state } = makeDispatcher();
    const warnings: object[] = [];
    const log = { info: () => {}, warn: (obj: object) => warnings.push(obj) };
    const fetchFn = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith('/ping')) return new Response('ok', { status: 200 });
      return response();
    }) as typeof fetch;
    const monitor = new NavidromeMonitor({
      url: 'http://navidrome.test', username: 'monitor', password: 'secret', metricsUrl: '', metricsPassword: '', intervalMs: 60_000,
    }, 'live', dispatcher, new IncidentManager(state, dispatcher, 'live', log), state, new HealthRegistry(), log, fetchFn);

    await monitor.tick();

    expect(warnings).toContainEqual({ reason });
  });

  it('reintenta una vez una desconexion transitoria antes de abrir incidente', async () => {
    const { dispatcher, sent, state } = makeDispatcher();
    const infos: object[] = [];
    let activityCalls = 0;
    const log = { info: (obj: object) => infos.push(obj), warn: () => {} };
    const fetchFn = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith('/ping')) return new Response('ok', { status: 200 });
      activityCalls += 1;
      if (activityCalls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', nowPlaying: { entry: [] } } }), { status: 200 });
    }) as typeof fetch;
    const monitor = new NavidromeMonitor({
      url: 'http://navidrome.test', username: 'monitor', password: 'secret', metricsUrl: '', metricsPassword: '', intervalMs: 60_000,
    }, 'live', dispatcher, new IncidentManager(state, dispatcher, 'live', log), state, new HealthRegistry(), log, fetchFn);

    await monitor.tick();

    expect(activityCalls).toBe(2);
    expect(sent).toHaveLength(0);
    expect(state.getIncident('navidrome.activity')).toBeUndefined();
    expect(infos).toContainEqual({ reason: 'network_econnreset' });
  });

  it('acepta una entrada unica y campos no textuales sin abrir incidente', async () => {
    const { dispatcher, sent, state } = makeDispatcher();
    const warnings: object[] = [];
    const log = { info: () => {}, warn: (obj: object) => warnings.push(obj) };
    const fetchFn = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith('/ping')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({
        'subsonic-response': { status: 'ok', nowPlaying: { entry: {
          id: 101, title: 'Tema', artist: null, album: { invalid: true }, username: 'usuario', playerId: 7,
        } } },
      }), { status: 200 });
    }) as typeof fetch;
    const monitor = new NavidromeMonitor({
      url: 'http://navidrome.test', username: 'monitor', password: 'secret', metricsUrl: '', metricsPassword: '', intervalMs: 60_000,
    }, 'live', dispatcher, new IncidentManager(state, dispatcher, 'live', log), state, new HealthRegistry(), log, fetchFn);

    await monitor.tick();

    expect(sent).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(state.getServiceBaseline('navidrome.initialized')).toBe('1');
  });

  it('asocia el cliente del proxy y emite solo la ubicacion, no la IP', async () => {
    const { dispatcher, sent, state } = makeDispatcher();
    const incidents = new IncidentManager(state, dispatcher, 'live', silentLog);
    let title = 'Tema uno';
    const fetchFn = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith('/ping')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({
        'subsonic-response': { status: 'ok', nowPlaying: { entry: [{
          id: title, title, artist: 'Artista', username: 'usuario', playerId: 'substreamer8 [okhttp]',
        }] } },
      }), { status: 200 });
    }) as typeof fetch;
    const monitor = new NavidromeMonitor({
      url: 'http://navidrome.test', username: 'monitor', password: 'secret', metricsUrl: '', metricsPassword: '', intervalMs: 60_000,
    }, 'live', dispatcher, incidents, state, new HealthRegistry(), silentLog, fetchFn,
    async () => [{ user: 'usuario', mediaId: 'Tema dos', ip: '198.51.100.40', seenAt: '2026-07-16T00:00:00Z' }],
    async () => 'Santiago, Chile');

    await monitor.tick();
    title = 'Tema dos';
    await monitor.tick();

    expect(sent[0]?.message).toContain('desde Santiago, Chile');
    expect(sent[0]?.message).not.toContain('198.51.100.40');
  });

  it('no infiere ubicacion si la misma pista tiene correlaciones ambiguas', async () => {
    const { dispatcher, sent, state } = makeDispatcher();
    const incidents = new IncidentManager(state, dispatcher, 'live', silentLog);
    let title = 'Tema uno';
    const fetchFn = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith('/ping')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({
        'subsonic-response': { status: 'ok', nowPlaying: { entry: [{
          id: title, title, artist: 'Artista', username: 'usuario', playerId: '1',
        }] } },
      }), { status: 200 });
    }) as typeof fetch;
    const monitor = new NavidromeMonitor({
      url: 'http://navidrome.test', username: 'monitor', password: 'secret', metricsUrl: '', metricsPassword: '', intervalMs: 60_000,
    }, 'live', dispatcher, incidents, state, new HealthRegistry(), silentLog, fetchFn,
    async () => [
      { user: 'usuario', mediaId: 'Tema dos', ip: '198.51.100.40', seenAt: '2026-07-16T00:00:00Z' },
      { user: 'usuario', mediaId: 'Tema dos', ip: '198.51.100.41', seenAt: '2026-07-16T00:00:01Z' },
    ], async () => 'Santiago, Chile');

    await monitor.tick();
    title = 'Tema dos';
    await monitor.tick();

    expect(sent[0]?.message).not.toContain('desde');
  });

  it('no reutiliza la ubicacion de una pista anterior sin una correlacion vigente', async () => {
    const { dispatcher, sent, state } = makeDispatcher();
    const incidents = new IncidentManager(state, dispatcher, 'live', silentLog);
    let title = 'Tema uno';
    const fetchFn = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith('/ping')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({
        'subsonic-response': { status: 'ok', nowPlaying: { entry: [{
          id: title, title, artist: 'Artista', username: 'usuario', playerId: '1',
        }] } },
      }), { status: 200 });
    }) as typeof fetch;
    const monitor = new NavidromeMonitor({
      url: 'http://navidrome.test', username: 'monitor', password: 'secret', metricsUrl: '', metricsPassword: '', intervalMs: 60_000,
    }, 'live', dispatcher, incidents, state, new HealthRegistry(), silentLog, fetchFn,
    async () => title === 'Tema uno'
      ? [{ user: 'usuario', mediaId: 'Tema uno', ip: '198.51.100.40', seenAt: '2026-07-16T00:00:00Z' }]
      : [],
    async () => 'Santiago, Chile');

    await monitor.tick();
    title = 'Tema dos';
    await monitor.tick();

    expect(sent[0]?.message).not.toContain('desde');
  });

  it('establece baseline, informa cambios de tema y valida metricas', async () => {
    const { dispatcher, sent, state } = makeDispatcher();
    const incidents = new IncidentManager(state, dispatcher, 'live', silentLog);
    let title = 'Tema uno';
    const fetchFn = vi.fn(async (url: URL | string) => {
      const value = String(url);
      if (value.endsWith('/ping')) return new Response('ok', { status: 200 });
      if (value.includes('metrics-private')) return new Response('# HELP navidrome_test test\n', { status: 200 });
      return new Response(JSON.stringify({
        'subsonic-response': { status: 'ok', nowPlaying: { entry: [{
          id: title, title, artist: 'Artista', album: 'Album', username: 'usuario', playerId: 'player-1',
        }] } },
      }), { status: 200 });
    }) as typeof fetch;
    const monitor = new NavidromeMonitor({
      url: 'http://navidrome.test', username: 'monitor', password: 'secret',
      metricsUrl: 'http://navidrome.test/metrics-private', metricsPassword: 'metric-secret', intervalMs: 60_000,
    }, 'live', dispatcher, incidents, state, new HealthRegistry(), silentLog, fetchFn);

    await monitor.tick();
    expect(sent).toHaveLength(0);
    expect(state.getServiceBaseline('navidrome.initialized')).toBe('1');

    title = 'Tema dos';
    await monitor.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ priority: 'normal' });
    expect(sent[0]?.message).toContain('NAVIDROME: usuario reproduce Artista - Tema dos');
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/rest/getNowPlaying.view'))).toBe(true);
  });
});
