import tls from 'node:tls';
import type { CanaryTargetConfig } from '../config.js';
import type { HealthRegistry } from '../health.js';
import type { IncidentManager, IncidentSeverity } from '../incidents.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

interface CanaryConfig {
  edge?: CanaryTargetConfig;
  targets: CanaryTargetConfig[];
  edgeIntervalMs: number;
  targetIntervalMs: number;
  certificateIntervalMs: number;
  certificateWarningDays: number;
  certificateCriticalDays: number;
}

type FetchLike = typeof fetch;

export class CanaryMonitor {
  private timers: NodeJS.Timeout[] = [];
  private failures = new Map<string, number>();
  private running = new Set<string>();

  constructor(
    private config: CanaryConfig,
    private incidents: IncidentManager,
    private health: HealthRegistry,
    private log: Logger,
    private fetchFn: FetchLike = fetch,
    private certificateExpiryFn: (hostname: string) => Promise<Date> = certificateExpiry,
    private now: () => Date = () => new Date(),
  ) {
    health.register('canary');
  }

  start(): void {
    if (this.timers.length) return;
    if (this.config.edge) {
      void this.runExclusive('edge', () => this.checkEdge());
      this.timers.push(setInterval(() => void this.runExclusive('edge', () => this.checkEdge()), this.config.edgeIntervalMs));
    }
    if (this.config.targets.length) {
      void this.runExclusive('targets', () => this.checkTargets());
      this.timers.push(setInterval(() => void this.runExclusive('targets', () => this.checkTargets()), this.config.targetIntervalMs));
      void this.runExclusive('certificates', () => this.checkCertificates());
      this.timers.push(setInterval(
        () => void this.runExclusive('certificates', () => this.checkCertificates()),
        this.config.certificateIntervalMs,
      ));
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  async checkEdge(): Promise<void> {
    if (!this.config.edge) return;
    const result = await this.probe(this.config.edge);
    await this.observeProbe(this.config.edge, result.ok, result.detail, 'edge');
    this.health.connected('canary');
  }

  async checkTargets(): Promise<void> {
    const results = await Promise.all(this.config.targets.map(async (target) => ({
      target,
      result: await this.probe(target),
    })));
    const failed = results.filter(({ result }) => !result.ok);
    for (const { target, result } of results) this.updateFailureCount(target.name, result.ok);

    if (failed.length >= 3) {
      const maxFailures = Math.max(...failed.map(({ target }) => this.failures.get(target.name) ?? 0));
      await this.incidents.observe({
        key: 'edge.multiple-domains',
        severity: failureSeverity(maxFailures),
        message: `EDGE: ${failed.length}/${results.length} dominios inaccesibles`,
      });
      for (const { target, result } of results.filter(({ result }) => result.ok)) {
        await this.incidents.observe({
          key: `canary.${target.name}`, severity: 'ok', message: `${target.name} accesible`,
        });
      }
    } else {
      await this.incidents.observe({
        key: 'edge.multiple-domains', severity: 'ok', message: 'dominios públicos accesibles',
      });
      for (const { target, result } of results) {
        const count = this.failures.get(target.name) ?? 0;
        if (result.ok) {
          await this.incidents.observe({
            key: `canary.${target.name}`, severity: 'ok', message: `${target.name} accesible`,
          });
        } else if (count >= 2) {
          await this.incidents.observe({
            key: `canary.${target.name}`,
            severity: failureSeverity(count),
            message: `CANARY ${target.name}: ${result.detail}`,
          });
        }
      }
    }
    this.health.connected('canary');
  }

  async checkCertificates(): Promise<void> {
    const hostnames = [...new Set(this.config.targets.map((target) => new URL(target.url).hostname))];
    for (const hostname of hostnames) {
      try {
        const expiry = await this.certificateExpiryFn(hostname);
        const probeKey = `certificate-probe.${hostname}`;
        this.failures.set(probeKey, 0);
        await this.incidents.observe({
          key: probeKey, severity: 'ok', message: `TLS ${hostname}: consulta operativa`,
        });
        const days = Math.floor((expiry.getTime() - this.now().getTime()) / 86_400_000);
        const severity: IncidentSeverity = days <= this.config.certificateCriticalDays
          ? 'critical' : days <= this.config.certificateWarningDays ? 'warning' : 'ok';
        await this.incidents.observe({
          key: `certificate.${hostname}`,
          severity,
          message: `TLS ${hostname}: vence en ${days} dias`,
        });
      } catch (err) {
        const key = `certificate-probe.${hostname}`;
        const count = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, count);
        if (count >= 2) {
          await this.incidents.observe({
            key,
            severity: failureSeverity(count),
            message: `TLS ${hostname}: no se pudo consultar (${String(err)})`,
          });
        }
      }
    }
    this.health.connected('canary');
  }

  private async runExclusive(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.running.has(name)) return;
    this.running.add(name);
    try {
      await fn();
    } catch (err) {
      this.health.disconnected('canary', String(err));
      this.log.warn({ name, err: String(err) }, 'canary check falló');
    } finally {
      this.running.delete(name);
    }
  }

  private async probe(target: CanaryTargetConfig): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await this.fetchFn(target.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      return {
        ok: response.status === target.expectedStatus,
        detail: `HTTP ${response.status}, esperado ${target.expectedStatus}`,
      };
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  }

  private async observeProbe(
    target: CanaryTargetConfig,
    ok: boolean,
    detail: string,
    prefix: string,
  ): Promise<void> {
    this.updateFailureCount(target.name, ok);
    const count = this.failures.get(target.name) ?? 0;
    if (ok) {
      await this.incidents.observe({
        key: `${prefix}.${target.name}`, severity: 'ok', message: `${target.name} accesible`,
      });
    } else if (count >= 2) {
      await this.incidents.observe({
        key: `${prefix}.${target.name}`,
        severity: failureSeverity(count),
        message: `EDGE ${target.name}: ${detail}`,
      });
    }
  }

  private updateFailureCount(name: string, ok: boolean): void {
    this.failures.set(name, ok ? 0 : (this.failures.get(name) ?? 0) + 1);
  }
}

function failureSeverity(failures: number): IncidentSeverity {
  if (failures >= 5) return 'critical';
  if (failures >= 2) return 'warning';
  return 'ok';
}

function certificateExpiry(hostname: string): Promise<Date> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 10_000 }, () => {
      const certificate = socket.getPeerCertificate();
      socket.end();
      const expiry = new Date(certificate.valid_to);
      if (!certificate.valid_to || Number.isNaN(expiry.getTime())) reject(new Error('certificado sin fecha válida'));
      else resolve(expiry);
    });
    socket.on('timeout', () => socket.destroy(new Error('timeout TLS')));
    socket.on('error', reject);
  });
}
