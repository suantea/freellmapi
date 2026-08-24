// Migration: analytics query performance indexes
// Created: 2026-08-24
//
// DOWN: reversible
//
// Analytics endpoints filter requests by created_at and join/filter on
// latency_ms, platform, status. Missing composite indexes force full table
// scans on these filters, causing the first analytics page load to stall when
// the raw requests table has accumulated significant rows. These indexes
// match the exact WHERE clause shapes in routes/analytics.ts so the query
// planner can seek directly into the window.

import type { Db } from '../types.js';

export function up(db: Db): void {
  // Covers the window filter + latency-null check used by percentile math
  // and the avg-latency query (server/src/routes/analytics.ts ~L108-110, L146-158).
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_requests_created_latency ON requests(created_at, latency_ms)',
  ).run();

  // Covers the by-platform endpoint: filter by created_at + platform, with
  // latency_ms included so the p95 sub-query can avoid a second table scan.
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_requests_created_platform_latency ON requests(created_at, platform, latency_ms)',
  ).run();

  // Covers the recent-calls endpoint which filters on created_at + status + provider.
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_requests_created_status ON requests(created_at, status)',
  ).run();
}

export function down(db: Db): void {
  db.prepare('DROP INDEX IF EXISTS idx_requests_created_latency').run();
  db.prepare('DROP INDEX IF EXISTS idx_requests_created_platform_latency').run();
  db.prepare('DROP INDEX IF EXISTS idx_requests_created_status').run();
}
