import OpenAI from 'openai';
import type { Config } from '../../config/config.js';

export function client(config: Config) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OpenRouter API key missing. Run /api sk-or-... in ILIDES or export OPENROUTER_API_KEY.');
  return new OpenAI({
    apiKey: key,
    baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 3,
    timeout: 180_000,
    defaultHeaders: { 'X-Title': 'ILIDES Code' },
  });
}

export { OpenAI };
