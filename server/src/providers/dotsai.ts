import { OpenAICompatProvider } from './openai-compat.js';

/**
 * Dots AI provider (OpenAI-compatible).
 * Docs: https://dots.ai/platform/docs
 * Base URL: https://api.dots.dev/api/v2
 */
export class DotsAIProvider extends OpenAICompatProvider {
  constructor(opts: { baseUrl?: string; timeoutMs?: number; keyless?: boolean } = {}) {
    super({
      platform: 'dots-ai',
      name: 'Dots AI',
      baseUrl: opts.baseUrl ?? 'https://api.dots.dev/api/v2',
      timeoutMs: opts.timeoutMs,
      keyless: opts.keyless,
    });
  }
}
