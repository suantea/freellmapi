import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getSetting, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

async function request(app: Express, method: string, path: string, body: any, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json };
}

describe('/api/settings/mcp-key-prefix', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('reports empty string by default', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/mcp-key-prefix', undefined, token);
    expect(status).toBe(200);
    expect(body).toEqual({ prefix: '' });
  });

  it('stores and returns the configured prefix', async () => {
    const put = await request(app, 'PUT', '/api/settings/mcp-key-prefix', { prefix: 'mcp_' }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ prefix: 'mcp_' });
    expect(getSetting('mcp_key_prefix')).toBe('mcp_');

    const get = await request(app, 'GET', '/api/settings/mcp-key-prefix', undefined, token);
    expect(get.body).toEqual(put.body);
  });

  it('allows empty string to disable prefix check', async () => {
    await request(app, 'PUT', '/api/settings/mcp-key-prefix', { prefix: 'mcp_' }, token);
    const put = await request(app, 'PUT', '/api/settings/mcp-key-prefix', { prefix: '' }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ prefix: '' });
    expect(getSetting('mcp_key_prefix')).toBe('');
  });

  const rejected: Array<[string, any]> = [
    ['non-string prefix', { prefix: 123 }],
    ['null prefix', { prefix: null }],
  ];

  for (const [label, payload] of rejected) {
    it(`rejects ${label} with a 400`, async () => {
      const { status, body } = await request(app, 'PUT', '/api/settings/mcp-key-prefix', payload, token);
      expect(status).toBe(400);
      expect(body.error.type).toBe('invalid_request_error');
    });
  }
});

describe('/api/settings/enable-mcp', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('reports false by default', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/enable-mcp', undefined, token);
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: false });
  });

  it('stores and returns the configured enabled flag', async () => {
    const put = await request(app, 'PUT', '/api/settings/enable-mcp', { enabled: true }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ enabled: true });
    expect(getSetting('enable_mcp')).toBe('1');

    const get = await request(app, 'GET', '/api/settings/enable-mcp', undefined, token);
    expect(get.body).toEqual(put.body);
  });

  it('accepts false to disable', async () => {
    await request(app, 'PUT', '/api/settings/enable-mcp', { enabled: true }, token);
    const put = await request(app, 'PUT', '/api/settings/enable-mcp', { enabled: false }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ enabled: false });
    expect(getSetting('enable_mcp')).toBe('0');
  });

  const rejected: Array<[string, any]> = [
    ['non-boolean enabled', { enabled: 'yes' }],
    ['null enabled', { enabled: null }],
  ];

  for (const [label, payload] of rejected) {
    it(`rejects ${label} with a 400`, async () => {
      const { status, body } = await request(app, 'PUT', '/api/settings/enable-mcp', payload, token);
      expect(status).toBe(400);
      expect(body.error.type).toBe('invalid_request_error');
    });
  }
});

describe('/mcp lifecycle gate (#925)', () => {
  let app: Express;
  let token: string;
  let unifiedKey: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
    unifiedKey = getUnifiedApiKey();
  });

  it('is off by default: POST /mcp answers 403 without touching auth', async () => {
    const { status, body } = await request(app, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, unifiedKey);
    expect(status).toBe(403);
    expect(body.error.code).toBe(-32000);
  });

  it('serves JSON-RPC once enabled, rejects wrong keys, and takes the toggle down immediately', async () => {
    const put = await request(app, 'PUT', '/api/settings/enable-mcp', { enabled: true }, token);
    expect(put.status).toBe(200);

    const ok = await request(app, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, unifiedKey);
    expect(ok.status).toBe(200);
    expect(ok.body.result).toBeDefined();

    const bad = await request(app, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'ping' }, 'freellmapi-not-the-key');
    expect(bad.status).toBe(401);

    await request(app, 'PUT', '/api/settings/enable-mcp', { enabled: false }, token);
    const off = await request(app, 'POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'ping' }, unifiedKey);
    expect(off.status).toBe(403);
  });
});