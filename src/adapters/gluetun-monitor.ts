import http from 'node:http';
import type { HealthRegistry } from '../health.js';
import type { IncidentManager } from '../incidents.js';
import type { StateStore } from '../state.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface GluetunMonitorConfig {
  dockerSocket: string;
  container: string;
  controlPort: number;
  apiKey: string;
  intervalMs: number;
}

interface VpnStatus { status: string }
interface PublicIp {
  public_ip: string;
  city?: string;
  region?: string;
  country?: string;
}

type EndpointFn = () => Promise<string>;
type FetchLike = typeof fetch;

/** Comprueba el tunel real; Docker ya cubre el estado del contenedor. */
export class GluetunMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private config: GluetunMonitorConfig,
    private incidents: IncidentManager,
    private state: StateStore,
    private health: HealthRegistry,
    private log: Logger,
    private endpointFn: EndpointFn = () => dockerContainerEndpoint(config.dockerSocket, config.container, config.controlPort),
    private fetchFn: FetchLike = fetch,
  ) {
    health.register('gluetun');
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const endpoint = await this.endpointFn();
      const [vpn, publicIp] = await Promise.all([
        getJson<VpnStatus>(this.fetchFn, `${endpoint}/v1/vpn/status`, this.config.apiKey),
        getJson<PublicIp>(this.fetchFn, `${endpoint}/v1/publicip/ip`, this.config.apiKey),
      ]);
      if (vpn.status !== 'running') {
        await this.incidents.observe({
          key: 'gluetun.vpn', severity: 'critical', message: `GLUETUN: VPN no operativo (${vpn.status})`,
        });
      } else {
        await this.incidents.observe({ key: 'gluetun.vpn', severity: 'ok', message: 'GLUETUN: VPN operativa' });
      }
      this.recordPublicIpChange(publicIp);
      this.health.connected('gluetun');
    } catch (err) {
      this.health.disconnected('gluetun', 'consulta de VPN fallida');
      this.log.warn({ err: String(err) }, 'consulta Gluetun falló');
      await this.incidents.observe({
        key: 'gluetun.vpn', severity: 'warning', message: 'GLUETUN: no se pudo comprobar el estado VPN',
      });
    } finally {
      this.running = false;
    }
  }

  private recordPublicIpChange(current: PublicIp): void {
    if (!current.public_ip) throw new Error('respuesta Gluetun sin IP publica');
    const key = 'gluetun.public-ip';
    const previous = this.state.getServiceBaseline(key);
    this.state.setServiceBaseline(key, current.public_ip);
    if (previous && previous !== current.public_ip) {
      this.state.incrInfo('gluetun.public-ip-change');
      this.log.info({ location: locationLabel(current) }, 'cambió la salida pública de Gluetun');
    }
  }
}

async function getJson<T>(fetchFn: FetchLike, url: string, apiKey: string): Promise<T> {
  const response = await fetchFn(url, {
    headers: { 'X-API-Key': apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Gluetun HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function dockerContainerEndpoint(socketPath: string, container: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const path = `/containers/${encodeURIComponent(container)}/json`;
    const request = http.get({ socketPath, path, timeout: 5_000 }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Docker HTTP ${response.statusCode ?? 'sin estado'}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        try {
          const value = JSON.parse(body) as { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } };
          const ip = Object.values(value.NetworkSettings?.Networks ?? {})
            .map((network) => network.IPAddress).find(Boolean);
          if (!ip) throw new Error('contenedor Gluetun sin IP de red');
          resolve(`http://${ip}:${port}`);
        } catch (err) {
          reject(err);
        }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('timeout consultando Docker')));
  });
}

function locationLabel(value: PublicIp): string {
  return [value.city, value.region, value.country].filter(Boolean).join(', ') || 'sin ubicacion';
}
