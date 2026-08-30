import { describe, it, expect } from 'vitest';
import { initDb } from '../../../db/index.js';
import { up, down } from '../../../db/migrations/20260830_000001_catalog_free_additions.js';
import { MIN_CATALOG_VERSION } from '../../../services/catalog-sync.js';
import type { Db } from '../../../db/types.js';

const ADDITIONS: Array<[string, string]> = [
  ['cloudflare', '@cf/qwen/qwen3.8-27b'],
  ['opencode', 'muse-spark-1.2-contributor-free'],
];

describe('20260830 catalog free additions (#1050 #1060)', () => {
  it('seeds both models with chain, profile and pricing rows on a fresh DB', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    for (const [platform, modelId] of ADDITIONS) {
      const model = db.prepare(`
        SELECT id, enabled, monthly_token_budget, context_window, supports_vision, supports_tools,
               paid_input_per_m, paid_output_per_m
          FROM models WHERE platform = ? AND model_id = ?
      `).get(platform, modelId) as any;
      expect(model, `${platform}/${modelId} seeded`).toBeDefined();
      expect(model.enabled).toBe(1);
      expect(model.supports_vision).toBe(1);
      expect(model.supports_tools).toBe(1);
      // applyModelPricing runs at the end of the baseline, after the seed.
      expect(model.paid_input_per_m).not.toBeNull();
      expect(model.paid_output_per_m).not.toBeNull();

      const chain = db.prepare('SELECT id FROM fallback_config WHERE model_db_id = ?').get(model.id);
      expect(chain, 'fallback_config row exists').toBeDefined();

      const profile = db.prepare('SELECT id FROM profile_models WHERE model_db_id = ?').get(model.id);
      expect(profile, 'auto-include profile row exists').toBeDefined();
    }
    db.close();
  });

  it('re-running up() does not duplicate rows, and down()/up() only toggles enabled', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const countsBefore = rowCounts(db);
    up(db);
    expect(rowCounts(db)).toEqual(countsBefore);

    // down() follows the V25 rollback semantic: disabled, not removed —
    // fallback history survives and row ids stay stable.
    down(db);
    for (const [platform, modelId] of ADDITIONS) {
      const model = db.prepare('SELECT enabled FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { enabled: number };
      expect(model.enabled).toBe(0);
    }
    expect(rowCounts(db)).toEqual(countsBefore);

    // Restores cleanly.
    up(db);
    for (const [platform, modelId] of ADDITIONS) {
      const model = db.prepare('SELECT enabled FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { enabled: number };
      expect(model.enabled).toBe(1);
    }
    expect(rowCounts(db)).toEqual(countsBefore);
    db.close();
  });

  it('MIN_CATALOG_VERSION covers this migration date so the stale monthly snapshot cannot prune the additions', () => {
    expect(MIN_CATALOG_VERSION >= '2026.08.30').toBe(true);
  });
});

function rowCounts(db: Db) {
  return {
    models: (db.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c,
    fallback: (db.prepare('SELECT COUNT(*) AS c FROM fallback_config').get() as { c: number }).c,
    profileModels: (db.prepare('SELECT COUNT(*) AS c FROM profile_models').get() as { c: number }).c,
  };
}
