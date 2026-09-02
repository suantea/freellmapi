import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { parseTaskTypeHeader, deriveTaskType, resolveTaskType, TASK_TYPE_HEADER } from '../../lib/task-type.js';

function reqWith(headerValue: string | undefined): Request {
  const headers: Record<string, string | string[] | undefined> = {};
  if (headerValue !== undefined) headers[TASK_TYPE_HEADER] = headerValue;
  return { headers } as unknown as Request;
}

describe('parseTaskTypeHeader', () => {
  it('reads an explicit code/chat declaration', () => {
    expect(parseTaskTypeHeader(reqWith('code'))).toBe('code');
    expect(parseTaskTypeHeader(reqWith('chat'))).toBe('chat');
  });

  it('treats the header as case-insensitive and trims whitespace', () => {
    expect(parseTaskTypeHeader(reqWith('  CODE '))).toBe('code');
    expect(parseTaskTypeHeader(reqWith('Chat'))).toBe('chat');
  });

  it('accepts an explicit auto and defaults to auto for anything else', () => {
    expect(parseTaskTypeHeader(reqWith('auto'))).toBe('auto');
    expect(parseTaskTypeHeader(reqWith('nonsense'))).toBe('auto');
    expect(parseTaskTypeHeader(reqWith(''))).toBe('auto');
    expect(parseTaskTypeHeader(reqWith(undefined))).toBe('auto');
  });

  it('takes the first value of a repeated header', () => {
    const req = { headers: { [TASK_TYPE_HEADER]: ['code', 'chat'] } } as unknown as Request;
    expect(parseTaskTypeHeader(req)).toBe('code');
  });
});

describe('deriveTaskType', () => {
  it('classifies a tool-bearing request as code', () => {
    expect(deriveTaskType([{ type: 'function' }], [{ role: 'user', content: 'hello' }])).toBe('code');
  });

  it('classifies a code-marked last user message as code', () => {
    expect(deriveTaskType(undefined, [{ role: 'user', content: '```python\nprint(1)\n```' }])).toBe('code');
    expect(deriveTaskType(undefined, [{ role: 'user', content: 'const x = 1;' }])).toBe('code');
    expect(deriveTaskType(undefined, [{ role: 'user', content: 'can you refactor this function?' }])).toBe('code');
  });

  it('falls back to chat for plain text, even with earlier code messages', () => {
    expect(deriveTaskType(undefined, [{ role: 'user', content: 'what is the weather in Berlin?' }])).toBe('chat');
    // Only the LAST user message counts — a stale code block from a previous turn is not intent.
    expect(deriveTaskType(undefined, [
      { role: 'user', content: '```js\nconst a = 1;\n```' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks!' },
    ])).toBe('chat');
  });

  it('handles missing tools/messages and array content blocks', () => {
    expect(deriveTaskType(undefined, undefined)).toBe('chat');
    expect(deriveTaskType(undefined, [])).toBe('chat');
    expect(deriveTaskType(undefined, [{ role: 'user', content: [{ type: 'text', text: '```sql\nSELECT 1\n```' }] }])).toBe('code');
  });
});

describe('resolveTaskType', () => {
  it('explicit declaration always wins over derivation', () => {
    expect(resolveTaskType(reqWith('chat'), [{ type: 'function' }], [{ role: 'user', content: '```js\nx\n```' }])).toBe('chat');
    expect(resolveTaskType(reqWith('code'), undefined, [{ role: 'user', content: 'hi' }])).toBe('code');
  });

  it('auto derives code upward and stays undefined otherwise (preset weights untouched)', () => {
    expect(resolveTaskType(reqWith('auto'), undefined, [{ role: 'user', content: '```rust\nfn main() {}\n```' }])).toBe('code');
    expect(resolveTaskType(reqWith('auto'), [{ type: 'function' }], undefined)).toBe('code');
    expect(resolveTaskType(reqWith('auto'), undefined, [{ role: 'user', content: 'hello there' }])).toBeUndefined();
    expect(resolveTaskType(reqWith(undefined), undefined, [{ role: 'user', content: 'hello there' }])).toBeUndefined();
  });
});
