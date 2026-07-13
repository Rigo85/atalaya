import pino from 'pino';
import { config } from './config.js';
import { StateStore } from './state.js';
import { GatewayClient } from './gateway.js';
import { Dispatcher } from './dispatcher.js';
import { DigestScheduler } from './digest.js';
import { DockerWatcher } from './adapters/docker-events.js';
import { Pm2Watcher } from './adapters/pm2-bus.js';
import { HealthRegistry } from './health.js';

const log = pino({ level: config.logLevel });

const state = new StateStore(config.statePath);
const gateway = new GatewayClient(
  { url: config.gatewayUrl, apiKey: config.apiKey, recipients: config.recipients },
  log,
);
const dispatcher = new Dispatcher(gateway, state, log);
const health = new HealthRegistry();

const digest = new DigestScheduler(gateway, state, config.digestHour, log, undefined, health);
const docker = new DockerWatcher(
  dispatcher,
  state,
  { sockPath: config.dockerSock, downGraceMs: config.downGraceMs, ignore: config.dockerIgnore },
  log,
  health,
);
const pm2Watcher = new Pm2Watcher(
  dispatcher,
  { stormCount: config.stormCount, stormWindowMs: config.stormWindowMs, selfName: 'atalaya' },
  log,
  Date.now,
  health,
);

digest.start();
pm2Watcher.start();
docker.start().catch((err) => {
  log.error({ err: String(err) }, 'no se pudo iniciar el watcher de docker');
});

void dispatcher.emit({ level: 'info', tag: 'atalaya.start' });
log.info(
  { digestHour: config.digestHour, recipients: config.recipients.length },
  'atalaya observando',
);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'apagando');
  digest.stop();
  docker.stop();
  pm2Watcher.stop();
  gateway.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
