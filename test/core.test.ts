import { describe, expect, it } from 'vitest';
import { DigestScheduler } from '../src/digest.js';
import { localDay } from '../src/state.js';
import { fakeGateway, makeDispatcher, silentLog, tempState } from './helpers.js';

describe('Dispatcher', () => {
  it('critical → SMS priority critical', async () => {
    const { dispatcher, sent } = makeDispatcher();
    await dispatcher.emit({ level: 'critical', tag: 'docker.down', message: '[DOCKER] x caido' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ message: '[DOCKER] x caido', priority: 'critical' });
  });

  it('warning → SMS priority high con dedup', async () => {
    const { dispatcher, sent } = makeDispatcher();
    await dispatcher.emit({ level: 'warning', tag: 'pm2.restart', message: '[PM2] y', dedupKey: 'pm2:restart:y' });
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

  it('rotate: el envío cierra el periodo y resetea contadores', async () => {
    const now = new Date('2026-07-12T21:02:00');
    const { digest, state } = makeDigest(21, now);
    state.incrInfo('docker.stop');
    await digest.tick();
    expect(state.data.today.info).toEqual({});
    expect(state.data.history).toHaveLength(1);
    expect(state.data.history[0]?.info['docker.stop']).toBe(1);
  });
});
