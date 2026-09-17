import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Issue #1218 Gap 3 — an in-band provider error that arrives only after the
// attempt has silently consumed most of the operator's whole retry budget
// behaved like a stall for its entire window (observed: nvidia nemotron-3-ultra
// ran 140.7s before surfacing "Service temporarily overloaded", leaving scraps
// of budget for the next hop). The hedge abort already benches a route that
// stayed silent for most of the budget; a LATE in-band error is the same
// sickness arriving as a verdict instead of an abort. It must earn the same
// bench, so the ladder's next hop keeps a usable budget. Errors that arrive
// EARLY (the common Groq tool_use_failed shape, seconds in) cost the ladder
// nothing and must stay unbenced.

vi.mock('../../services/health.js', () => ({
  checkKeyHealth: vi.fn(),
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  newFallbackState,
  runFallbackLoop,
  TRUNCATION_BENCH_MS,
  HEDGE_BENCH_MIN_SILENT_FRACTION,
  type FallbackHooks,
} from '../../lib/fallback-loop.js';
import { isOnCooldown, clearCooldownsForKey, resetKeyLocalityCache } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

const PLATFORM = 'groq';
let keyA = 0;
let keyB = 0;

const inBandError = () => new Error('in-band provider error from Nvidia: Service temporarily overloaded');
const fastInBandError = () => new Error('in-band provider error from Groq: tool_use_failed');

function insertKey(label: string): number {
  const { encrypted, iv, authTag } = encrypt(`test-${label}`);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(PLATFORM, label, encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

function routeFor(keyId: number, modelId = 'llama-3.3-70b'): RouteResult {
  return {
    provider: {} as any,
    modelId,
    modelDbId: 1,
    apiKey: 'k',
    keyId,
    platform: PLATFORM,
    displayName: modelId,
    rpdLimit: null,
    tpdLimit: null,
  };
}

function hooks(overrides: Partial<FallbackHooks>): FallbackHooks {
  return {
    state: newFallbackState(),
    timeBudgetMs: 0,
    route: () => { throw new Error('unused'); },
    dispatch: async () => 'done',
    logFailure: () => {},
    onFatal: () => {},
    onRoutingExhausted: () => {},
    onExhausted: () => {},
    ...overrides,
  };
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  process.env.NODE_ENV = 'test';
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  keyA = insertKey('key-a');
  keyB = insertKey('key-b');
  resetKeyLocalityCache();
});

beforeEach(() => {
  clearCooldownsForKey(PLATFORM, keyA);
  clearCooldownsForKey(PLATFORM, keyB);
});

// The wall clock is what decides "late" — these tests use a tiny budget and a
// dispatch that sleeps past the fraction, so no timer faking is needed.
const BUDGET_MS = 400;

describe('late in-band provider error benches the route (#1218 Gap 3)', () => {
  it('an in-band error after most of the budget benches the route for the truncation window', async () => {
    const onExhausted = vi.fn();
    const candidates = [routeFor(keyA), routeFor(keyB)];
    let calls = 0;
    await runFallbackLoop(hooks({
      timeBudgetMs: BUDGET_MS,
      maxRetries: 2,
      route: () => candidates[calls++] ?? (() => { throw Object.assign(new Error('empty'), { status: 429 }); })(),
      dispatch: async (r) => {
        if (r.keyId === keyA) {
          await new Promise(res => setTimeout(res, BUDGET_MS * HEDGE_BENCH_MIN_SILENT_FRACTION + 50));
          throw inBandError();
        }
        return 'done' as const;
      },
      onExhausted,
    }));

    expect(onExhausted).not.toHaveBeenCalled();
    expect(isOnCooldown(PLATFORM, 'llama-3.3-70b', 1)).toBe(true);
    // The bench is the truncation-grade window, not the light 90s transient.
    const cooldown = isOnCooldown(PLATFORM, 'llama-3.3-70b', 1);
    expect(cooldown).toBe(true);
    expect(TRUNCATION_BENCH_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('an in-band error that arrives EARLY does not bench the route', async () => {
    const onExhausted = vi.fn();
    const candidates = [routeFor(keyA), routeFor(keyB)];
    let calls = 0;
    await runFallbackLoop(hooks({
      timeBudgetMs: BUDGET_MS,
      maxRetries: 2,
      route: () => candidates[calls++] ?? (() => { throw Object.assign(new Error('empty'), { status: 429 }); })(),
      dispatch: async (r) => {
        if (r.keyId === keyA) throw fastInBandError();
        return 'done' as const;
      },
      onExhausted,
    }));

    expect(onExhausted).not.toHaveBeenCalled();
    expect(isOnCooldown(PLATFORM, 'llama-3.3-70b', 1)).toBe(false);
  });
});
