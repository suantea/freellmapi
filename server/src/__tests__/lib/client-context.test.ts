import { afterEach, describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { clientContextMiddleware, getClientContext, setObservedRequestTokens, getObservedRequestTokens } from '../../lib/client-context.js';

// Minimal fake req: the middleware only touches headers, socket, and req.ip.
// `ip` is what Express resolves from the socket peer address (or from the
// X-Forwarded-For chain when `trust proxy` is enabled) — the middleware reads
// req.ip rather than re-implementing the trust chain itself (#1024).
function fakeReq(headers: Record<string, string | string[]>, remoteAddress?: string, ip?: string): Request {
  return { headers, socket: { remoteAddress }, ip } as unknown as Request;
}

// Run the middleware and capture the context visible to downstream code
// (i.e. what logRequest would read inside the request's async scope).
function contextFor(req: Request): ReturnType<typeof getClientContext> {
  let seen = getClientContext();
  clientContextMiddleware(req, {} as Response, (() => { seen = getClientContext(); }) as NextFunction);
  return seen;
}

describe('clientContextMiddleware', () => {
  afterEach(() => {
    delete process.env.REQUEST_ANALYTICS_LOG_CLIENT;
  });

  it('captures the socket peer address and user agent', () => {
    const ctx = contextFor(fakeReq({ 'user-agent': 'curl/8.6.0' }, '192.168.0.42'));
    expect(ctx).toEqual({ ip: '192.168.0.42', userAgent: 'curl/8.6.0', agent: 'unknown', observedRequestTokens: null });
  });

  it('uses Express-resolved req.ip (trust-proxy chain) when available', () => {
    // With TRUST_PROXY enabled, Express resolves req.ip to the first untrusted
    // hop of the X-Forwarded-For chain; the middleware trusts that resolution.
    const ctx = contextFor(fakeReq(
      { 'x-forwarded-for': '10.1.2.3, 172.16.0.1', 'user-agent': 'ua' },
      '127.0.0.1',
      '10.1.2.3',
    ));
    expect(ctx.ip).toBe('10.1.2.3');
  });

  it('falls back to the socket peer address when req.ip is absent', () => {
    const ctx = contextFor(fakeReq(
      { 'x-forwarded-for': '10.1.2.3, 172.16.0.1', 'user-agent': 'ua' },
      '127.0.0.1',
    ));
    // trust proxy disabled → spoofed header ignored, socket address used.
    expect(ctx.ip).toBe('127.0.0.1');
  });

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    const ctx = contextFor(fakeReq({}, '::ffff:192.168.0.5'));
    expect(ctx.ip).toBe('192.168.0.5');
  });

  it('truncates oversized user agents to 256 chars', () => {
    const ctx = contextFor(fakeReq({ 'user-agent': 'x'.repeat(1000) }, '1.2.3.4'));
    expect(ctx.userAgent).toHaveLength(256);
  });

  it('stores nulls when REQUEST_ANALYTICS_LOG_CLIENT=false', () => {
    process.env.REQUEST_ANALYTICS_LOG_CLIENT = 'false';
    const ctx = contextFor(fakeReq({ 'user-agent': 'curl/8.6.0' }, '192.168.0.42'));
    expect(ctx).toEqual({ ip: null, userAgent: null, agent: null, observedRequestTokens: null });
  });

  it('returns nulls outside any request scope', () => {
    expect(getClientContext()).toEqual({ ip: null, userAgent: null, agent: null, observedRequestTokens: null });
  });
});

describe('setObservedRequestTokens / getObservedRequestTokens', () => {
  it('returns null outside any request scope and is a no-op setter', () => {
    expect(getObservedRequestTokens()).toBeNull();
    // Setter is a no-op when no store is active — must not throw.
    setObservedRequestTokens(12345);
    expect(getObservedRequestTokens()).toBeNull();
  });

  it('sticky-writes the value inside a request scope', () => {
    let seen: number | null = null;
    clientContextMiddleware({ headers: {}, socket: {} } as unknown as Request, {} as Response, (() => {
      setObservedRequestTokens(36_532);
      seen = getObservedRequestTokens();
    }) as NextFunction);
    expect(seen).toBe(36_532);
  });

  it('never decreases — max of current and incoming wins', () => {
    clientContextMiddleware({ headers: {}, socket: {} } as unknown as Request, {} as Response, (() => {
      setObservedRequestTokens(40_000);
      setObservedRequestTokens(10_000); // smaller, must be ignored
      setObservedRequestTokens(50_000); // larger, takes over
      expect(getObservedRequestTokens()).toBe(50_000);
    }) as NextFunction);
  });

  it('scope is per-request — one request cannot leak into another', () => {
    const captured: Array<number | null> = [];
    clientContextMiddleware({ headers: {}, socket: {} } as unknown as Request, {} as Response, (() => {
      setObservedRequestTokens(99_999);
      captured.push(getObservedRequestTokens());
    }) as NextFunction);
    clientContextMiddleware({ headers: {}, socket: {} } as unknown as Request, {} as Response, (() => {
      captured.push(getObservedRequestTokens()); // new scope → null
    }) as NextFunction);
    expect(captured).toEqual([99_999, null]);
  });
});
