import { describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../src/gateway.js';

const cfg = { url: 'http://gateway.test', apiKey: 'key', recipients: ['+51911111111'] };
const opts = { message: 'alerta', priority: 'critical' as const };

function logger() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe('GatewayClient', () => {
  it('acepta una notificación encolada y una deduplicada', async () => {
    for (const response of [
      new Response('{"status":"queued"}', { status: 202 }),
      new Response('{"status":"suppressed","reason":"dedup"}', { status: 200 }),
    ]) {
      const client = new GatewayClient(cfg, logger(), vi.fn(async () => response) as typeof fetch);
      expect(await client.send(opts)).toBe(true);
    }
  });

  it('no interpreta un 2xx suprimido por capacidad como enviado', async () => {
    const log = logger();
    const fetchFn = vi.fn(async () => new Response('{"status":"suppressed"}', { status: 202 }));
    const client = new GatewayClient(cfg, log, fetchFn as typeof fetch);
    expect(await client.send(opts)).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('429 se registra y no se reintenta', async () => {
    const fetchFn = vi.fn(async () => new Response('{"status":"suppressed"}', { status: 429 }));
    const client = new GatewayClient(cfg, logger(), fetchFn as typeof fetch);
    expect(await client.send(opts)).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('503 respeta Retry-After antes de reintentar', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503, headers: { 'retry-after': '60' } }))
      .mockResolvedValueOnce(new Response('{"status":"queued"}', { status: 202 }));
    const delays: number[] = [];
    const client = new GatewayClient(
      cfg,
      logger(),
      fetchFn as typeof fetch,
      async (ms) => { delays.push(ms); },
    );
    expect(await client.send(opts)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([60_000]);
  });

  it('limita Retry-After remoto a cinco minutos', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503, headers: { 'retry-after': '3600' } }))
      .mockResolvedValueOnce(new Response('{"status":"queued"}', { status: 202 }));
    const delays: number[] = [];
    const client = new GatewayClient(
      cfg,
      logger(),
      fetchFn as typeof fetch,
      async (ms) => { delays.push(ms); },
    );
    expect(await client.send(opts)).toBe(true);
    expect(delays).toEqual([300_000]);
  });
});
