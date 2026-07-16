import 'dotenv/config';
import type { MonitorMode } from './incidents.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

const recipients = (process.env.ALERT_RECIPIENTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (recipients.length === 0) throw new Error('ALERT_RECIPIENTS vacío: al menos un número');

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} inválido`);
  return value;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function monitorMode(): MonitorMode {
  const value = process.env.HOST_MONITOR_MODE ?? 'off';
  if (value !== 'off' && value !== 'dry-run' && value !== 'live') {
    throw new Error('HOST_MONITOR_MODE debe ser off, dry-run o live');
  }
  return value;
}

export interface CanaryTargetConfig {
  name: string;
  url: string;
  expectedStatus: number;
}

function canaryTargets(): CanaryTargetConfig[] {
  const raw = process.env.CANARY_TARGETS ?? '';
  if (!raw.trim()) return [];
  return raw.split(';').map((entry) => {
    const [name, url, status] = entry.split('|').map((value) => value?.trim());
    const expectedStatus = Number(status);
    if (!name || !url || !Number.isInteger(expectedStatus)) {
      throw new Error(`CANARY_TARGETS inválido: ${entry}`);
    }
    return { name, url, expectedStatus };
  });
}

export const config = {
  gatewayUrl: (process.env.GATEWAY_URL ?? 'http://localhost:8090').replace(/\/+$/, ''),
  apiKey: required('ATALAYA_API_KEY'),
  recipients,
  digestHour: Number(process.env.DIGEST_HOUR ?? 21),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  statePath: process.env.STATE_PATH ?? 'state.json',
  hostMonitorMode: monitorMode(),
  hostCheckMs: numberEnv('HOST_CHECK_MS', 60_000),
  systemMounts: listEnv('HOST_SYSTEM_MOUNTS'),
  mediaMounts: listEnv('HOST_MEDIA_MOUNTS'),
  smartSnapshotCommand: process.env.SMART_SNAPSHOT_COMMAND ?? '',
  smartCheckMs: numberEnv('SMART_CHECK_MS', 6 * 60 * 60_000),
  libretorioBackupDir: process.env.LIBRETORIO_BACKUP_DIR ?? '',
  backupCheckMs: numberEnv('BACKUP_CHECK_MS', 30 * 60_000),
  edgeCanaryUrl: process.env.EDGE_CANARY_URL ?? '',
  edgeCanaryExpectedStatus: numberEnv('EDGE_CANARY_EXPECTED_STATUS', 200),
  canaryTargets: canaryTargets(),
  edgeCanaryCheckMs: numberEnv('EDGE_CANARY_CHECK_MS', 60_000),
  canaryCheckMs: numberEnv('CANARY_CHECK_MS', 5 * 60_000),
  certificateCheckMs: numberEnv('CERTIFICATE_CHECK_MS', 24 * 60 * 60_000),
  vpsHost: process.env.VPS_MONITOR_HOST ?? '',
  vpsUser: process.env.VPS_MONITOR_USER ?? 'ubuntu',
  vpsPort: numberEnv('VPS_MONITOR_PORT', 22),
  vpsKeyPath: process.env.VPS_MONITOR_KEY ?? '',
  vpsCheckMs: numberEnv('VPS_CHECK_MS', 60_000),
  gluetunContainer: process.env.GLUETUN_CONTAINER ?? 'gluetun',
  gluetunControlPort: numberEnv('GLUETUN_CONTROL_PORT', 8000),
  gluetunControlApiKey: process.env.GLUETUN_CONTROL_API_KEY ?? '',
  gluetunCheckMs: numberEnv('GLUETUN_CHECK_MS', 60_000),
  qbittorrentUrl: (process.env.QBITTORRENT_URL ?? '').replace(/\/+$/, ''),
  qbittorrentUsername: process.env.QBITTORRENT_USERNAME ?? '',
  qbittorrentPassword: process.env.QBITTORRENT_PASSWORD ?? '',
  qbittorrentCheckMs: numberEnv('QBITTORRENT_CHECK_MS', 60_000),
  jellyfinUrl: (process.env.JELLYFIN_URL ?? '').replace(/\/+$/, ''),
  jellyfinApiKey: process.env.JELLYFIN_API_KEY ?? '',
  jellyfinCheckMs: numberEnv('JELLYFIN_CHECK_MS', 60_000),
  geoIpDatabase: process.env.GEOIP_CITY_DATABASE ?? '',
  geoIpLookupCommand: process.env.GEOIP_LOOKUP_COMMAND ?? '',
  aonsokuUrl: (process.env.AONSOKU_URL ?? '').replace(/\/+$/, ''),
  aonsokuContainer: process.env.AONSOKU_CONTAINER ?? 'aonsoku',
  aonsokuCheckMs: numberEnv('AONSOKU_CHECK_MS', 60_000),
  navidromeUrl: (process.env.NAVIDROME_URL ?? '').replace(/\/+$/, ''),
  navidromeContainer: process.env.NAVIDROME_CONTAINER ?? 'navidrome',
  navidromeUsername: process.env.NAVIDROME_USERNAME ?? '',
  navidromePassword: process.env.NAVIDROME_PASSWORD ?? '',
  navidromeMetricsUrl: (process.env.NAVIDROME_METRICS_URL ?? '').replace(/\/+$/, ''),
  navidromeMetricsPassword: process.env.NAVIDROME_METRICS_PASSWORD ?? '',
  navidromeCheckMs: numberEnv('NAVIDROME_CHECK_MS', 60_000),
  serviceLogCheckMs: numberEnv('SERVICE_LOG_CHECK_MS', 60_000),

  thresholds: {
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
    certificateWarningDays: 14,
    certificateCriticalDays: 5,
  },

  // reglas (constantes de diseño; a settings/env solo si hiciera falta ajustarlas)
  dockerSock: '/var/run/docker.sock',
  /** gracia antes de declarar caído un contenedor que murió con exit != 0 */
  downGraceMs: 90_000,
  /** tormenta de reinicios pm2: N reinicios en la ventana → crítico */
  stormCount: 3,
  stormWindowMs: 10 * 60_000,
  /** contenedores a ignorar (por subcadena del nombre) */
  dockerIgnore: (process.env.DOCKER_IGNORE ?? 'buildx').split(',').map((s) => s.trim()).filter(Boolean),
};
