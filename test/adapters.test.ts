import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerWatcher, type DockerEventMsg } from '../src/adapters/docker-events.js';
import { Pm2Watcher } from '../src/adapters/pm2-bus.js';
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

  it('stop ordenado (exit 0) → sin SMS, cuenta en digest y sale del inventario', async () => {
    const { watcher, sent, state } = makeWatcher();
    state.addExpectedContainer('it-tools');
    watcher.handleEvent(dockerEvent('it-tools', 'die', 0));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(0);
    expect(state.data.today.info['docker.stop']).toBe(1);
    expect(state.data.expectedContainers).not.toContain('it-tools');
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

  it('restart suelto → warning; tormenta → critical una sola vez', async () => {
    const now = { t: 1_000_000 };
    const { watcher, sent } = makeWatcher(now);
    await watcher.handleEvent({ event: 'restart', process: { name: 'neutron' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ priority: 'high', dedupKey: 'pm2:restart:neutron' });

    now.t += 60_000;
    await watcher.handleEvent({ event: 'restart', process: { name: 'neutron' } });
    now.t += 60_000;
    await watcher.handleEvent({ event: 'restart', process: { name: 'neutron' } });
    now.t += 1_000;
    await watcher.handleEvent({ event: 'restart', process: { name: 'neutron' } });

    const criticals = sent.filter((s) => s.priority === 'critical');
    expect(criticals).toHaveLength(1);
    expect(criticals[0]?.message).toContain('bucle de reinicios');
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
});
