// Migration: add two live free models to the catalog (#1050, #1060)
// Created: 2026-08-30
//
// - cloudflare/@cf/qwen/qwen3.8-27b — Qwen3.8 27B on Workers AI: vision +
//   function calling + reasoning, 262k context (#1050). Draws on the same
//   10k Neurons/day free pool as the other Cloudflare rows; at ~248 Neurons
//   per ~900-token request that is ~40 requests/day ≈ 1-2M tokens/month,
//   the label below.
// - opencode/muse-spark-1.2-contributor-free — Meta Muse Spark 1.2 on
//   OpenCode Zen, the free contributor variant (#1060): same limited-time
//   promo terms as the other Zen -free rows, with the contributor caveat
//   that prompts/completions may be used to train future Meta models.
//
// MIN_CATALOG_VERSION is bumped to this migration's date in the same change:
// the currently published monthly snapshot predates these rows, and sync
// prunes catalog-managed models the fetched catalog doesn't list — without
// the bump the next sync would delete them again until the promote lands.
//
// UP: inserts the rows (fresh installs), re-enables them if a previous down()
// disabled them, backfills the fallback chain and auto-include profiles, and
// re-applies the paid-equivalent pricing map.
//
// DOWN: disables, does NOT delete — the same rollback semantic V25 uses for
// retired Zen promos ("disabled, not removed"): fallback history survives,
// row ids stay stable for the migration round trip, and a locally disabled
// row is never re-enabled by catalog sync (catalog + local disables both
// win). A later catalog promote that stops listing these models prunes them
// through the normal source='catalog' path.

import type { Db } from '../types.js';
import { applyModelPricing } from '../model-pricing.js';

// Columns: platform, model_id, display_name, intelligence_rank, speed_rank,
// size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
// monthly_token_budget, context_window, enabled, supports_vision, supports_tools
const ADDITIONS: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null, number, number, number]> = [
  ['cloudflare', '@cf/qwen/qwen3.8-27b',              'Qwen3.8 27B (CF)',                               6, 11, 'Large',    null, null, null, null, '~1-2M',         262144, 1, 1, 1],
  ['opencode',   'muse-spark-1.2-contributor-free',   'Muse Spark 1.2 Contributor Free (OpenCode Zen)', 5,  4, 'Frontier', 20,   200,  null, null, 'promo (trial)', 131072, 1, 1, 1],
];

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const reenable = db.prepare('UPDATE models SET enabled = 1 WHERE platform = ? AND model_id = ?');
  const apply = db.transaction(() => {
    let priority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
    for (const a of ADDITIONS) {
      insert.run(...a);
      reenable.run(a[0], a[1]);
      const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(a[0], a[1]) as { id: number };
      // Chain invariant (same one migrations and catalog-sync keep): every
      // model has a fallback_config row.
      db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(row.id, ++priority);
      // Auto-include profiles: append if missing, chain order preserved.
      const profiles = db.prepare('SELECT id FROM profiles WHERE auto_include_new_models = 1').all() as { id: number }[];
      for (const p of profiles) {
        const inProfile = db.prepare('SELECT 1 FROM profile_models WHERE profile_id = ? AND model_db_id = ?').get(p.id, row.id);
        if (inProfile) continue;
        const max = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM profile_models WHERE profile_id = ?').get(p.id) as { mx: number }).mx;
        const enabled = (db.prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(row.id) as { enabled: number }).enabled;
        db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)').run(p.id, row.id, max + 1, enabled);
      }
    }
    // The baseline seeded paid-equivalent pricing before these rows existed;
    // re-apply the map (idempotent, ~100 UPDATEs) so the additions get theirs.
    applyModelPricing(db);
  });
  apply();
}

export function down(db: Db): void {
  const disable = db.prepare('UPDATE models SET enabled = 0 WHERE platform = ? AND model_id = ?');
  const apply = db.transaction(() => {
    for (const [platform, modelId] of ADDITIONS) disable.run(platform, modelId);
  });
  apply();
}
