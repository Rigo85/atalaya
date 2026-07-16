import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HostSnapshot, SnapshotCollector } from './host-monitor.js';

const execFileAsync = promisify(execFile);

export interface EgressSnapshot {
  dayBytes: number;
  monthBytes: number;
  sampledAt: string;
}

export interface NavidromeClientRecord {
  user: string;
  mediaId: string;
  ip: string;
  seenAt: string;
}

export class RemoteVpsClient {
  constructor(
    private host: string,
    private user: string,
    private port: number,
    private keyPath: string,
  ) {}

  collector(): SnapshotCollector {
    return () => this.run<HostSnapshot>('host');
  }

  async egress(): Promise<EgressSnapshot> {
    const value = await this.run<Record<string, unknown>>('egress');
    const dayBytes = Number(value.day_bytes);
    const monthBytes = Number(value.month_bytes);
    const sampledAt = String(value.sampled_at ?? '');
    if (!Number.isFinite(dayBytes) || dayBytes < 0 || !Number.isFinite(monthBytes) || monthBytes < 0 || !sampledAt) {
      throw new Error('respuesta egress inválida');
    }
    return { dayBytes, monthBytes, sampledAt };
  }

  async navidromeClients(): Promise<NavidromeClientRecord[]> {
    const value = await this.run<unknown>('navidrome-clients');
    if (!Array.isArray(value)) throw new Error('respuesta navidrome-clients inválida');
    return value.filter((entry): entry is NavidromeClientRecord => {
      if (!entry || typeof entry !== 'object') return false;
      const record = entry as Partial<NavidromeClientRecord>;
      return typeof record.user === 'string' && typeof record.mediaId === 'string'
        && typeof record.ip === 'string' && typeof record.seenAt === 'string';
    });
  }

  private async run<T>(command: 'host' | 'egress' | 'navidrome-clients'): Promise<T> {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=yes',
      '-i', this.keyPath,
      '-p', String(this.port),
      `${this.user}@${this.host}`,
      command,
    ];
    const { stdout } = await execFileAsync('ssh', args, { timeout: command === 'egress' ? 60_000 : 15_000 });
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new Error(`respuesta ${command} no es JSON`);
    }
  }
}
