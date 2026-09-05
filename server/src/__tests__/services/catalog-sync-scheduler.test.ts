import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { startCatalogSync, stopCatalogSync } from '../../services/catalog-sync.js';
import type { Scheduler } from '../../lib/scheduler.js';

function makeScheduler() {
  const every: { ms: number; fn: () => void | Promise<void> }[] = [];
  const after: { ms: number; fn: () => void | Promise<void> }[] = [];
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const scheduler: Scheduler = {
    every(ms, fn) {
      const cancel = vi.fn();
      every.push({ ms, fn });
      cancels.push(cancel);
      return cancel;
    },
    after(ms, fn) {
      const cancel = vi.fn();
      after.push({ ms, fn });
      cancels.push(cancel);
      return cancel;
    },
  };
  return { scheduler, every, after, cancels };
}

describe('startCatalogSync / stopCatalogSync', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    stopCatalogSync();
    delete process.env.CATALOG_SYNC_DISABLED;
  });

  // #934: a fresh install (no media_models rows) fast-boots the catalog sync
  // at 500 ms; once transcription models exist the full BOOT_DELAY applies.
  const seedTranscriptionModel = () => {
    getDb().prepare(`
      INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id, meta_json)
      VALUES (?, ?, ?, ?, ?, 1, '', ?, ?)
    `).run('groq', 'whisper-large-v3-turbo', 'Whisper Large v3 Turbo', 'transcription', 1, null, null);
  };
  const clearMediaModels = () => {
    getDb().prepare('DELETE FROM media_models').run();
  };

  it('registers a 10-second boot delay and a 12-hour interval once models exist', () => {
    seedTranscriptionModel();
    const { scheduler, every, after } = makeScheduler();
    startCatalogSync(scheduler);
    expect(after).toHaveLength(1);
    expect(after[0].ms).toBe(10 * 1000);
    expect(every).toHaveLength(1);
    expect(every[0].ms).toBe(12 * 60 * 60 * 1000);
  });

  it('fast-boots at 500 ms on a fresh install with no media models (#934)', () => {
    clearMediaModels();
    const { scheduler, after } = makeScheduler();
    startCatalogSync(scheduler);
    expect(after).toHaveLength(1);
    expect(after[0].ms).toBe(500);
  });

  it('is idempotent — double-start registers only one set of jobs', () => {
    const { scheduler, every, after } = makeScheduler();
    startCatalogSync(scheduler);
    startCatalogSync(scheduler);
    expect(after).toHaveLength(1);
    expect(every).toHaveLength(1);
  });

  it('registers nothing when CATALOG_SYNC_DISABLED=1', () => {
    process.env.CATALOG_SYNC_DISABLED = '1';
    const { scheduler, every, after } = makeScheduler();
    startCatalogSync(scheduler);
    expect(after).toHaveLength(0);
    expect(every).toHaveLength(0);
  });

  it('stop invokes both cancel handles', () => {
    const { scheduler, cancels } = makeScheduler();
    startCatalogSync(scheduler);
    stopCatalogSync();
    expect(cancels).toHaveLength(2);
    cancels.forEach((c) => expect(c).toHaveBeenCalledOnce());
  });

  it('can re-register after stop', () => {
    const { scheduler: s1 } = makeScheduler();
    startCatalogSync(s1);
    stopCatalogSync();

    const { scheduler: s2, every, after } = makeScheduler();
    startCatalogSync(s2);
    expect(after).toHaveLength(1);
    expect(every).toHaveLength(1);
  });
});
