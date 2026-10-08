import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

/**
 * Lightweight API client for Nomus backend.
 * Uses only Node.js built-in modules (no axios/fetch polyfill needed in VS Code).
 */
export class NomusApiClient {
  private getApiKey: () => Promise<string | undefined>;

  constructor(getApiKey: () => Promise<string | undefined>) {
    this.getApiKey = getApiKey;
  }

  private getBaseUrl(): string {
    const config = vscode.workspace.getConfiguration('nomus');
    return config.get<string>('apiUrl', 'http://localhost:3100');
  }

  async get<T = unknown>(path: string): Promise<T | null> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return null;

    const baseUrl = this.getBaseUrl();
    const fullUrl = `${baseUrl}${path}`;

    return new Promise((resolve) => {
      const mod = fullUrl.startsWith('https') ? https : http;
      const req = mod.get(fullUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            console.error(`Nomus API GET ${path} returned HTTP ${res.statusCode}`);
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T | null> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return null;

    const baseUrl = this.getBaseUrl();
    const url = new URL(`${baseUrl}${path}`);
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : '';

    return new Promise((resolve) => {
      const req = mod.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            console.error(`Nomus API POST ${path} returned HTTP ${res.statusCode}`);
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    });
  }
}
