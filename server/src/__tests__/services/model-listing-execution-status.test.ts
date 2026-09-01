import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { buildModelListing } from '../../services/model-listing.js';

// #1100: /v1/models gains a per-model execution_status (ready / needsKey /
// exhausted) derived from the live api_keys.status of each model's candidate
// keys, so agents can filter ?execution_status=ready and route around
// exhausted models instead of 429ing.

function seedModel(platform: string, modelId: string, enabled = 1) {
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled)
    VALUES (?, ?, ?, 5, 5, 'Medium', NULL, NULL, NULL, NULL, '', ?)
  `).run(platform, modelId, modelId, enabled);
}

function seedKey(platform: string, status: string, enabled = 1) {
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, 'x', 'x', 'x', ?, ?)
  `).run(platform, `${platform}-${status}`, status, enabled);
}

function statusFor(modelId: string) {
  const m = buildModelListing().models.find(x => x.id === modelId);
  return m?.executionStatus;
}

describe('buildModelListing execution_status (#1100)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.UNIFY_MODELS = 'false';
    initDb(':memory:');
  });

  it('marks a model ready when a healthy enabled key exists', () => {
    seedModel('groq', 'ready-model');
    seedKey('groq', 'healthy');
    expect(statusFor('ready-model')).toBe('ready');
  });

  it('treats an unprobed (unknown) key as ready, not exhausted', () => {
    seedModel('groq', 'unknown-model');
    seedKey('groq', 'unknown');
    expect(statusFor('unknown-model')).toBe('ready');
  });

  it('marks a model needsKey when no enabled key exists', () => {
    seedModel('groq', 'nokey-model');
    expect(statusFor('nokey-model')).toBe('needsKey');
  });

  it('marks a model exhausted when every candidate key is rate-limited or invalid', () => {
    seedModel('groq', 'exhausted-model');
    seedKey('groq', 'rate_limited');
    seedKey('groq', 'invalid');
    expect(statusFor('exhausted-model')).toBe('exhausted');
  });

  it('stays ready when at least one of several keys is healthy', () => {
    seedModel('groq', 'mixed-model');
    seedKey('groq', 'rate_limited');
    seedKey('groq', 'healthy');
    expect(statusFor('mixed-model')).toBe('ready');
  });

  it('marks a disabled model needsKey regardless of keys', () => {
    seedModel('groq', 'disabled-model', 0);
    seedKey('groq', 'healthy');
    expect(statusFor('disabled-model')).toBe('needsKey');
  });
});
