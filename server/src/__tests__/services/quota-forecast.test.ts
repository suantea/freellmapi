commit 3d3cc3a31ce4f5b5b2fc271e3158c39e6c7d521a
Author: suantea <suantea@users.noreply.github.com>
Date:   Wed Sep 9 00:03:05 2026 +0800

    fix(lint): remove unused vi import in quota-forecast test

diff --git a/server/src/__tests__/services/quota-forecast.test.ts b/server/src/__tests__/services/quota-forecast.test.ts
index 751ced5f..df04b37e 100644
--- a/server/src/__tests__/services/quota-forecast.test.ts
+++ b/server/src/__tests__/services/quota-forecast.test.ts
@@ -1,4 +1,4 @@
-import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
+import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
 import { initDb, getDb } from '../../db/index.js';
 import { getQuotaForecast } from '../../services/quota-forecast.js';
 
