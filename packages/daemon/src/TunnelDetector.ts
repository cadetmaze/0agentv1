import { execSync, spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

export interface TunnelResult {
  type: 'cloudflare' | 'ngrok' | 'lan';
  public_url: string;
  local_url: string;
  process?: ReturnType<typeof spawn>;
}

export class TunnelDetector {
  constructor(private port: number) {}

  getLocalIP(): string {
    const nets = networkInterfaces();
    for (const iface of Object.values(nets)) {
      if (!iface) continue;
      for (const net of iface) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
    return '127.0.0.1';
  }

  async openTunnel(): Promise<TunnelResult> {
    const localIp = this.getLocalIP();
    const localUrl = `http://${localIp}:${this.port}`;

    // Try cloudflared first (free, no account)
    if (this.hasCommand('cloudflared')) {
      const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${this.port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.unref();

      const url = await this.waitForUrl(proc, /https:\/\/[a-z0-9\-]+\.trycloudflare\.com/i, 10_000);
      if (url) return { type: 'cloudflare', public_url: url, local_url: localUrl, process: proc };
      proc.kill();
    }

    // Try ngrok
    if (this.hasCommand('ngrok')) {
      const proc = spawn('ngrok', ['http', String(this.port), '--log=stdout'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.unref();

      const url = await this.waitForUrl(proc, /https:\/\/[a-z0-9\-]+\.ngrok[.\-][a-z]+/i, 8_000);
      if (url) return { type: 'ngrok', public_url: url, local_url: localUrl, process: proc };
      proc.kill();
    }

    // Fallback: LAN only
    return { type: 'lan', public_url: localUrl, local_url: localUrl };
  }

  private hasCommand(cmd: string): boolean {
    try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
  }

  private waitForUrl(proc: ReturnType<typeof spawn>, pattern: RegExp, timeout: number): Promise<string | null> {
    return new Promise(resolve => {
      const chunks: string[] = [];
      const onData = (d: Buffer) => {
        const s = d.toString();
        chunks.push(s);
        const match = chunks.join('').match(pattern);
        if (match) { cleanup(); resolve(match[0]); }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      const timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout?.removeListener('data', onData);
        proc.stderr?.removeListener('data', onData);
      };
    });
  }
}
