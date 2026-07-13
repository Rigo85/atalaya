import pino from 'pino';
import { config } from './config.js';
import { StateStore } from './state.js';
import { GatewayClient } from './gateway.js';
import { Dispatcher } from './dispatcher.js';
import { DigestScheduler } from './digest.js';
import { DockerWatcher } from './adapters/docker-events.js';
import { Pm2Watcher } from './adapters/pm2-bus.js';

const log = pino({ level: config.logLevel });

const state = new StateStore(config.statePath);
const gateway = new GatewayClient(
  { url: config.gatewayUrl, apiKey: config.apiKey, recipients: config.recipients },
  log,
);
const dispatcher = new Dispatcher(gateway, state, log);

const digest = new DigestScheduler(gateway, state, config.digestHour, log);
const docker = new DockerWatcher(
  dispatcher,
  state,
  { sockPath: config.dockerSock, downGraceMs: config.downGraceMs, ignore: config.dockerIgnore },
  log,
);
const pm2Watcher = new Pm2Watcher(
  dispatcher,
  { stormCount: config.stormCount, stormWindowMs: config.stormWindowMs, selfName: 'atalaya' },
  log,
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

const shutdown = (signal: string): void => {
  log.info({ signal }, 'apagando');
  digest.stop();
  docker.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
