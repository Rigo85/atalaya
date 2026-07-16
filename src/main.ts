import pino from 'pino';
import { config } from './config.js';
import { StateStore } from './state.js';
import { GatewayClient } from './gateway.js';
import { Dispatcher } from './dispatcher.js';
import { DigestScheduler } from './digest.js';
import { DockerWatcher } from './adapters/docker-events.js';
import { Pm2Watcher } from './adapters/pm2-bus.js';
import { HealthRegistry } from './health.js';
import { IncidentManager } from './incidents.js';
import { HostMonitor, LocalHostCollector } from './adapters/host-monitor.js';
import { RemoteVpsClient } from './adapters/remote-vps.js';
import { CanaryMonitor } from './adapters/canary.js';
import { BackupMonitor } from './adapters/backup-monitor.js';
import { SmartMonitor } from './adapters/smart-monitor.js';
import { GluetunMonitor } from './adapters/gluetun-monitor.js';
import { QbittorrentMonitor } from './adapters/qbittorrent-monitor.js';
import { JellyfinMonitor, mmdbLocator } from './adapters/jellyfin-monitor.js';
import { StaticWebMonitor } from './adapters/static-web-monitor.js';
import { ContainerLogMonitor, aonsokuLogError, navidromeLogError } from './adapters/container-log-monitor.js';
import { NavidromeMonitor } from './adapters/navidrome-monitor.js';

const log = pino({ level: config.logLevel });

const state = new StateStore(config.statePath);
const gateway = new GatewayClient(
  { url: config.gatewayUrl, apiKey: config.apiKey, recipients: config.recipients },
  log,
);
const dispatcher = new Dispatcher(gateway, state, log);
const health = new HealthRegistry();
const incidents = new IncidentManager(state, dispatcher, config.hostMonitorMode, log);

const monitors: Array<{ start: () => void; stop: () => void }> = [];
const mounts = [...new Set([...config.systemMounts, ...config.mediaMounts])];
if (config.hostMonitorMode !== 'off' && mounts.length) {
  const collector = new LocalHostCollector(mounts);
  monitors.push(new HostMonitor(
    'local', 'host', () => collector.collect(), new Set(config.systemMounts), new Set(config.mediaMounts),
    config.thresholds, config.hostCheckMs, incidents, state, health, log,
  ));
}

let remoteVps: RemoteVpsClient | undefined;
if (config.hostMonitorMode !== 'off' && config.vpsHost && config.vpsKeyPath) {
  remoteVps = new RemoteVpsClient(config.vpsHost, config.vpsUser, config.vpsPort, config.vpsKeyPath);
  monitors.push(new HostMonitor(
    'vps', 'vps', remoteVps.collector(), new Set(['/']), new Set(), config.thresholds,
    config.vpsCheckMs, incidents, state, health, log,
  ));
}

if (config.hostMonitorMode !== 'off' && (config.edgeCanaryUrl || config.canaryTargets.length)) {
  monitors.push(new CanaryMonitor({
    edge: config.edgeCanaryUrl ? {
      name: 'public-gateway', url: config.edgeCanaryUrl, expectedStatus: config.edgeCanaryExpectedStatus,
    } : undefined,
    targets: config.canaryTargets,
    edgeIntervalMs: config.edgeCanaryCheckMs,
    targetIntervalMs: config.canaryCheckMs,
    certificateIntervalMs: config.certificateCheckMs,
    certificateWarningDays: config.thresholds.certificateWarningDays,
    certificateCriticalDays: config.thresholds.certificateCriticalDays,
  }, incidents, health, log));
}

if (config.hostMonitorMode !== 'off' && config.libretorioBackupDir) {
  monitors.push(new BackupMonitor(
    config.libretorioBackupDir, config.backupCheckMs, incidents, health, log,
  ));
}

if (config.hostMonitorMode !== 'off' && config.smartSnapshotCommand) {
  monitors.push(new SmartMonitor(
    config.smartSnapshotCommand, config.smartCheckMs, incidents, state, health, log,
  ));
}

if (config.hostMonitorMode !== 'off' && config.gluetunControlApiKey) {
  monitors.push(new GluetunMonitor({
    dockerSocket: config.dockerSock,
    container: config.gluetunContainer,
    controlPort: config.gluetunControlPort,
    apiKey: config.gluetunControlApiKey,
    intervalMs: config.gluetunCheckMs,
  }, incidents, state, health, log));
}

if (config.hostMonitorMode !== 'off' && config.qbittorrentUrl
  && config.qbittorrentUsername && config.qbittorrentPassword) {
  monitors.push(new QbittorrentMonitor({
    url: config.qbittorrentUrl,
    username: config.qbittorrentUsername,
    password: config.qbittorrentPassword,
    intervalMs: config.qbittorrentCheckMs,
  }, dispatcher, incidents, state, health, log));
}

if (config.hostMonitorMode !== 'off' && config.jellyfinUrl && config.jellyfinApiKey) {
  monitors.push(new JellyfinMonitor({
    url: config.jellyfinUrl,
    apiKey: config.jellyfinApiKey,
    intervalMs: config.jellyfinCheckMs,
  }, config.hostMonitorMode, dispatcher, incidents, state, health, log, fetch,
  mmdbLocator(config.geoIpLookupCommand, config.geoIpDatabase)));
}

if (config.hostMonitorMode !== 'off' && config.aonsokuUrl) {
  monitors.push(new StaticWebMonitor({
    name: 'aonsoku', url: config.aonsokuUrl, requiredPaths: ['/', '/env-config.js'], intervalMs: config.aonsokuCheckMs,
  }, incidents, health, log));
  monitors.push(new ContainerLogMonitor({
    container: config.aonsokuContainer, adapter: 'aonsoku-logs', stateKey: 'aonsoku.logs.cursor',
    tag: 'aonsoku', incidentKey: 'aonsoku.logs', serviceLabel: 'AONSOKU', intervalMs: config.serviceLogCheckMs,
    errorThreshold: 3, matchesError: aonsokuLogError,
  }, incidents, state, health, log));
}

if (config.hostMonitorMode !== 'off' && config.navidromeUrl) {
  const navidromeClientRecords = config.navidromeClientLocationEnabled && remoteVps
    ? () => remoteVps.navidromeClients()
    : undefined;
  monitors.push(new NavidromeMonitor({
    url: config.navidromeUrl, username: config.navidromeUsername, password: config.navidromePassword,
    metricsUrl: config.navidromeMetricsUrl, metricsPassword: config.navidromeMetricsPassword,
    intervalMs: config.navidromeCheckMs,
  }, config.hostMonitorMode, dispatcher, incidents, state, health, log, fetch,
  navidromeClientRecords, mmdbLocator(config.geoIpLookupCommand, config.geoIpDatabase)));
  monitors.push(new ContainerLogMonitor({
    container: config.navidromeContainer, adapter: 'navidrome-logs', stateKey: 'navidrome.logs.cursor',
    tag: 'navidrome', incidentKey: 'navidrome.logs', serviceLabel: 'NAVIDROME', intervalMs: config.serviceLogCheckMs,
    errorThreshold: 3, matchesError: navidromeLogError,
  }, incidents, state, health, log));
}

const digest = new DigestScheduler(
  gateway,
  state,
  config.digestHour,
  log,
  undefined,
  health,
  async () => {
    if (!remoteVps) return { activeIncidents: state.activeIncidentCount() };
    try {
      const egress = await remoteVps.egress();
      await incidents.observe({ key: 'vps.egress', severity: 'ok', message: 'OCI egress disponible' });
      return {
        activeIncidents: state.activeIncidentCount(),
        egressDayBytes: egress.dayBytes,
        egressMonthBytes: egress.monthBytes,
      };
    } catch (err) {
      await incidents.observe({
        key: 'vps.egress', severity: 'warning', message: `OCI egress: sin datos (${String(err)})`,
      });
      return { activeIncidents: state.activeIncidentCount(), egressUnavailable: true };
    }
  },
);
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
for (const monitor of monitors) monitor.start();

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
  for (const monitor of monitors) monitor.stop();
  gateway.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
