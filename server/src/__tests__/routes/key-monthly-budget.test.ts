import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { nextMonthResetAt } from '../../services/key-budget.js';

let server: Server;
let baseUrl: string;
let token: string;
let model: string;
beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  const secret = encrypt('synthetic-budget-test-key');
  const keyId = Number(db.prepare(`INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, enabled, status, monthly_request_cap)
    VALUES ('groq', ?, ?, ?, 1, 'healthy', 1)`).run(secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
  model = (db.prepare("SELECT model_id FROM models WHERE platform = 'groq' LIMIT 1").get() as { model_id: string }).model_id;
  db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms)
    VALUES ('groq', ?, ?, 'success', 10, 5, 1)`).run(model, keyId);
  token = getUnifiedApiKey();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));

describe('monthly budget exhaustion on inference endpoints', () => {
  it.each(['/v1/chat/completions', '/v1/responses', '/v1/messages'])('%s returns quota_exceeded and the month reset header', async path => {
    const input = path === '/v1/responses' ? { input: 'hello' } : { messages: [{ role: 'user', content: 'hello' }] };
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, model, max_tokens: 20 }),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    // Anthropic translates the error type but keeps the shared retry header.
    if (path !== '/v1/messages') expect(body.error.code).toBe('quota_exceeded');
    const retry = Number(res.headers.get('Retry-After'));
    const expected = Math.ceil((Date.parse(nextMonthResetAt()) - Date.now()) / 1000);
    expect(retry).toBeGreaterThanOrEqual(expected - 1);
    expect(retry).toBeLessThanOrEqual(expected + 1);
  });
});
