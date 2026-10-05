import { client } from '../providers/openrouter/client.js';
import type { Config } from '../config/config.js';

/**
 * Single non-streaming completion (no tools). Used by /commit, web_search and
 * other one-shot helpers.
 */
export async function completeOnce(config: Config, messages: any[], workspace = ''): Promise<string> {
  const ai = client(config);
  const resp: any = await ai.chat.completions.create({
    model: config.model,
    messages,
    temperature: config.temperature,
    stream: false,
  } as any);
  void workspace;
  const content = resp?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Empty completion from the model');
  return content.trim();
}
