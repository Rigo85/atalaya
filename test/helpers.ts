import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.js';
import { GatewayClient, type SendOptions } from '../src/gateway.js';
import { Dispatcher } from '../src/dispatcher.js';

export const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function tempState(): StateStore {
  return new StateStore(join(mkdtempSync(join(tmpdir(), 'atalaya-')), 'state.json'));
}

/** GatewayClient con fetch falso que registra los envíos */
export function fakeGateway(): { client: GatewayClient; sent: SendOptions[]; failWith?: () => number } {
  const box: { client: GatewayClient; sent: SendOptions[]; failStatus: number | null } = {
    client: null as unknown as GatewayClient,
    sent: [],
    failStatus: null,
  };
  const fetchFn = (async (_url: unknown, init?: { body?: string }) => {
    if (box.failStatus) return new Response('{}', { status: box.failStatus });
    const body = JSON.parse(String(init?.body ?? '{}'));
    box.sent.push({ message: body.message, priority: body.priority, dedupKey: body.dedup_key });
    return new Response('{}', { status: 202 });
  }) as typeof fetch;
  box.client = new GatewayClient(
    { url: 'http://gw.test', apiKey: 'k', recipients: ['+15555550100'] },
    silentLog,
    fetchFn,
  );
  return box as unknown as { client: GatewayClient; sent: SendOptions[] };
}

export function makeDispatcher(): { dispatcher: Dispatcher; sent: SendOptions[]; state: StateStore } {
  const state = tempState();
  const gw = fakeGateway();
  return { dispatcher: new Dispatcher(gw.client, state, silentLog), sent: gw.sent, state };
}
