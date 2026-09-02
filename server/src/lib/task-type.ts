// Task-type-aware routing (#1127): lets a client declare what kind of work a
// request is (code vs chat) so the router can bias the bandit weights toward
// quality or speed. A coding turn is quality-sensitive — a weak model
// "completes" it with wrong code the user must manually verify; a chat turn is
// budget/speed-sensitive. The declared header is the strongest signal; when it
// is absent or `auto`, a cheap bounded rule derives the type from the request
// shape (tool-bearing requests → code; code markers in the last user message →
// code). The result is a SOFT preference: capability gates and the failover
// chain are untouched, and `undefined` means "leave the preset weights alone".

import type { Request } from 'express';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from './content.js';

export type TaskType = 'code' | 'chat' | 'auto';

export const TASK_TYPE_HEADER = 'x-freellmapi-task-type';

// Bounded scan so a huge user message never costs the router a full read.
const MAX_SCAN_CHARS = 4000;

// Loose markers that a turn is about code. Deliberately permissive — a false
// positive only shifts a small weight delta, never drops a route.
const CODE_MARKER_RE =
  /```|```[a-z0-9_+-]*\n|<\w+\/?>|function\s+\w+\s*\(|def\s+\w+\s*\(|const\s+\w+\s*=|let\s+\w+\s*=|=>|class\s+\w+|import\s+(?:\{|\w+\s+from)|require\(|\b(?:refactor|function|method|class|git|npm|yarn|pip|rustc|cargo|docker|curl)\b/i;

/** Read the client-declared task type from the request header (default 'auto'). */
export function parseTaskTypeHeader(req: Request): TaskType {
  const raw = req.headers[TASK_TYPE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim().toLowerCase();
  return trimmed === 'code' || trimmed === 'chat' || trimmed === 'auto' ? trimmed : 'auto';
}

/** Derive a concrete task type from the request shape. Bounded, never throws. */
export function deriveTaskType(tools: unknown[] | undefined, messages: ChatMessage[] | undefined): 'code' | 'chat' {
  // Tool-bearing requests are overwhelmingly agent/coding turns.
  if (tools && tools.length > 0) return 'code';
  const lastUser = messages ? [...messages].reverse().find((m) => m.role === 'user') : undefined;
  const text = lastUser ? contentToString(lastUser.content) : '';
  if (text.length > 0 && CODE_MARKER_RE.test(text.slice(0, MAX_SCAN_CHARS))) return 'code';
  return 'chat';
}

/**
 * Resolve the effective task bias for a request: the explicit header wins;
 * `auto` falls back to derivation. Returns undefined when there is no signal
 * worth biasing for — callers then leave the routing weights untouched, so the
 * default behaviour is unchanged. `auto` only ever biases UP toward `code`:
 * `chat` is the ordinary case, and silently re-weighting the bulk of traffic
 * in `auto` mode would defeat the point of an opt-in knob.
 */
export function resolveTaskType(
  req: Request,
  tools: unknown[] | undefined,
  messages: ChatMessage[] | undefined,
): 'code' | 'chat' | undefined {
  const declared = parseTaskTypeHeader(req);
  if (declared === 'code' || declared === 'chat') return declared;
  return deriveTaskType(tools, messages) === 'code' ? 'code' : undefined;
}
