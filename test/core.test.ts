import { describe, expect, it, vi } from 'vitest';
import { DigestScheduler } from '../src/digest.js';
import { GatewayClient } from '../src/gateway.js';
import { localDay } from '../src/state.js';
import { HealthRegistry } from '../src/health.js';
import { fakeGateway, makeDispatcher, silentLog, tempState } from './helpers.js';

describe('Dispatcher', () => {
  it('critical → SMS priority critical', async () => {
    const { dispatcher, sent, state } = makeDispatcher();
    await dispatcher.emit({ level: 'critical', tag: 'docker.down', message: 'DOCKER: x caido' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ message: 'DOCKER: x caido', priority: 'critical' });
    expect(state.data.today).toMatchObject({ critical: 1, accepted: 1, rejected: 0 });
  });

  it('warning → SMS priority high con dedup', async () => {
    const { dispatcher, sent } = makeDispatcher();
    await dispatcher.emit({ level: 'warning', tag: 'pm2.restart', message: 'PM2: y', dedupKey: 'pm2:restart:y' });
    expect(sent[0]).toMatchObject({ priority: 'high', dedupKey: 'pm2:restart:y' });
  });

  it('info → solo contador, sin SMS', async () => {
    const { dispatcher, sent, state } = makeDispatcher();
    await dispatcher.emit({ level: 'info', tag: 'docker.stop' });
    await dispatcher.emit({ level: 'info', tag: 'docker.stop' });
    expect(sent).toHaveLength(0);
    expect(state.data.today.info['docker.stop']).toBe(2);
  });
});

describe('DigestScheduler', () => {
  function makeDigest(hour: number, fakeNow: Date) {
    const state = tempState();
    const gw = fakeGateway();
    const digest = new DigestScheduler(gw.client, state, hour, silentLog, () => fakeNow);
    return { digest, state, sent: gw.sent };
  }

  it('no envía antes de la hora; envía una sola vez después', async () => {
    const now = new Date('2026-07-12T20:59:00');
    const { digest, sent, state } = makeDigest(21, now);
    await digest.tick();
    expect(sent).toHaveLength(0);

    now.setHours(21, 0, 30);
    await digest.tick();
    expect(sent).toHaveLength(1);
    expect(state.data.lastDigestDate).toBe(localDay(now));

    await digest.tick(); // mismo día: no repite
    expect(sent).toHaveLength(1);
  });

  it('compose: sin novedades y con contadores', async () => {
    const now = new Date('2026-07-12T21:01:00');
    const { digest, state } = makeDigest(21, now);
    expect(digest.compose()).toBe('Atalaya 12/07: sin novedades');

    state.incrAlert('critical');
    state.incrAlert('warning');
    state.incrAlert('warning');
    state.incrInfo('docker.stop');
    state.incrInfo('docker.stop');
    state.incrInfo('pm2.stop');
    const msg = digest.compose();
    expect(msg).toContain('1 critico');
    expect(msg).toContain('2 avisos');
    expect(msg).toContain('docker.stop x2');
    expect(msg.length).toBeLessThanOrEqual(160);
    expect(/^[\x20-\x7E]+$/.test(msg)).toBe(true); // ASCII puro (GSM-7)
  });

  it('heartbeat declara adapters degradados y nunca dice sin novedades', () => {
    const now = new Date('2026-07-12T21:01:00');
    const state = tempState();
    const gw = fakeGateway();
    const health = new HealthRegistry();
    health.connected('docker');
    const digest = new DigestScheduler(gw.client, state, 21, silentLog, () => now, health);
    expect(digest.compose()).toContain('DEGRADADO pm2');
    expect(digest.compose()).not.toContain('sin novedades');
  });

  it('rotate: el envío cierra el periodo y resetea contadores', async () => {
    const now = new Date('2026-07-12T21:02:00');
    const { digest, state } = makeDigest(21, now);
    state.incrInfo('docker.stop');
    await digest.tick();
    expect(state.data.today.info).toEqual({});
    expect(state.data.history).toHaveLength(1);
    expect(state.data.history[0]?.info['docker.stop']).toBe(1);
  });

  it('dos ticks simultáneos producen un solo digest y una sola rotación', async () => {
    const now = new Date('2026-07-12T21:02:00');
    const state = tempState();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fetchFn = vi.fn(async () => {
      await pending;
      return new Response('{"status":"queued"}', { status: 202 });
    });
    const gateway = new GatewayClient(
      { url: 'http://gw.test', apiKey: 'k', recipients: ['+15555550100'] },
      silentLog,
      fetchFn as typeof fetch,
    );
    const digest = new DigestScheduler(gateway, state, 21, silentLog, () => now);

    const first = digest.tick();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    await digest.tick();
    release();
    await first;

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(state.data.history).toHaveLength(1);
  });

  it('divide sin truncar y conserva eventos ocurridos durante un reintento', async () => {
    const now = new Date('2026-07-12T21:02:00');
    const state = tempState();
    for (let i = 0; i < 18; i++) state.incrInfo(`evento-muy-largo-${String(i).padStart(2, '0')}`);
    const seen: string[] = [];
    let failures = 0;
    const fetchFn = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { message: string; dedup_key: string };
      seen.push(body.message);
      if (body.dedup_key.endsWith('core-2') && failures++ < 3) return new Response('{}', { status: 500 });
      return new Response('{}', { status: 202 });
    }) as typeof fetch;
    const gateway = new GatewayClient(
      { url: 'http://gw.test', apiKey: 'k', recipients: ['+15555550100'] },
      silentLog,
      fetchFn,
      async () => {},
    );
    const digest = new DigestScheduler(gateway, state, 21, silentLog, () => now);
    const parts = digest.composeParts();
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.message.length <= 160)).toBe(true);
    expect(parts.map((part) => part.message).join(' ')).toContain('evento-muy-largo-17');

    await digest.tick();
    expect(state.getPendingDigest()).not.toBeNull();
    expect(state.data.history).toHaveLength(0);
    state.incrInfo('evento-posterior');
    await digest.tick();
    expect(state.getPendingDigest()).toBeNull();
    expect(state.data.history).toHaveLength(1);
    expect(state.data.today.info['evento-posterior']).toBe(1);
    expect(seen.some((message) => message.includes('evento-muy-largo-17'))).toBe(true);
  });
});
