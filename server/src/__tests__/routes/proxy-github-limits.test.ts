import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { GITHUB_MAX_INPUT_TOKENS } from '../../lib/content.js';
import { GITHUB_MAX_OUTPUT_TOKENS } from '../../lib/sampling-params.js';
import { mintDashboardToken } from '../helpers/auth.js';

// GitHub Models is the strictest free platform in the catalog: it 400s on a
// max_tokens above its own ceiling and 413s on a long history instead of
// truncating it. Both are pre-dispatch rejections, so without these guards a
// github hop is a guaranteed wasted attempt on every oversized request — and
// the same oversized body rides the rest of the chain.

let dashToken = '';

async function request(app: Express, path: string, body: any, headers: Record<string, string>) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE body */ }
  return { status: res.status, body: json };
}

describe('github platform limits', () => {
  let app: Express;
  const sent: any[] = [];

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    sent.length = 0;
    // Only a github key, so every route the chain can pick is a github one.
    const { status } = await request(app, '/api/keys',
      { platform: 'github', key: 'ghp_github_limits_test', label: 't' },
      { Authorization: `Bearer ${dashToken}` });
    expect(status).toBe(201);

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (!urlStr.includes('models.github.ai')) return origFetch(url as any, init);
      sent.push(JSON.parse(String((init as RequestInit).body)));
      return new Response(JSON.stringify({
        id: 'gh1', object: 'chat.completion', created: 1, model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clamps an aggressive max_tokens to the platform ceiling instead of 400ing', async () => {
    const r = await request(app, '/v1/chat/completions', {
      model: 'gpt-4o', max_tokens: 65536,
      messages: [{ role: 'user', content: 'hello' }],
    }, { Authorization: `Bearer ${getUnifiedApiKey()}` });

    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].max_tokens).toBe(GITHUB_MAX_OUTPUT_TOKENS);
  });

  it('trims a long history to the platform input budget before dispatch', async () => {
    // 1900 tokens per turn under the chars/4 estimate: four of them plus the
    // question sit above the 7500-token input budget but still inside the
    // model's 8000-token context window, so routing picks github and the
    // guard — not the router — is what has to shrink the request. (max_tokens
    // 1 keeps the routing output reserve out of the way.)
    const turn = (c: string) => c.repeat(7600);
    const messages = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: turn('a') },
      { role: 'assistant', content: turn('b') },
      { role: 'user', content: turn('c') },
      { role: 'assistant', content: turn('d') },
      { role: 'user', content: 'the actual question' },
    ];

    const r = await request(app, '/v1/chat/completions', {
      model: 'gpt-4o', max_tokens: 1, messages,
    }, { Authorization: `Bearer ${getUnifiedApiKey()}` });

    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    const out = sent[0].messages as Array<{ role: string; content: string }>;
    // System prompt and the newest turn survive; the oldest turns are gone.
    expect(out[0].role).toBe('system');
    expect(out[out.length - 1].content).toBe('the actual question');
    expect(out.length).toBeLessThan(messages.length);
    expect(out.some(m => m.content === turn('a'))).toBe(false);
    const tokens = out.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    expect(tokens).toBeLessThanOrEqual(GITHUB_MAX_INPUT_TOKENS);
  });

  it('leaves a history that already fits untouched', async () => {
    const messages = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ];
    const r = await request(app, '/v1/chat/completions', {
      model: 'gpt-4o', max_tokens: 1, messages,
    }, { Authorization: `Bearer ${getUnifiedApiKey()}` });

    expect(r.status).toBe(200);
    expect(sent[0].messages.map((m: any) => m.content)).toEqual(messages.map(m => m.content));
  });
});
