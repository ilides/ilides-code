import type { Config } from '../config/config.js';
import { completeOnce } from '../agent/complete.js';

const MAX_CHARS = 50_000;

/** Crude HTML → readable text (no external deps). */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  try { s = decodeURIComponent(s); } catch { /* leave as-is */ }
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(l => l.trim()).join('\n')
    .trim();
}

export function webFetchTool(): { run: (args: any) => Promise<string> } {
  return {
    run: async ({ url }) => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return 'ERROR: url must start with http:// or https://';
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'ILIDES-Code/0.4 (+https://github.com/ilides/ilides-code)', 'Accept': 'text/html,application/xhtml+xml,text/plain,*/*' },
      });
      if (!res.ok) return `ERROR: HTTP ${res.status} ${res.statusText} for ${url}`;
      const type = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      const text = /html|xml|svg/i.test(type) ? htmlToText(raw) : raw;
      const body = text.slice(0, MAX_CHARS);
      const more = text.length > MAX_CHARS ? `\n…[page truncated: ${text.length} chars total]` : '';
      return `URL: ${url} · ${type || 'unknown type'} · ${text.length} chars\n\n${body}${more}`;
    },
  };
}

/**
 * web_search via OpenRouter's `:online` suffix (no extra API key):
 * runs one cheap completion with web access and asks for results with sources.
 */
export function webSearchTool(config: Config | undefined, workspace: string): { run: (args: any) => Promise<string> } {
  return {
    run: async ({ query }) => {
      if (!config) return 'ERROR: web_search requires a model configuration.';
      if (typeof query !== 'string' || !query.trim()) return 'ERROR: query is required';
      const model = config.model.includes(':') ? config.model : `${config.model}:online`;
      const answer = await completeOnce(
        { ...config, model, temperature: 0 },
        [{ role: 'user', content: `Web search: ${query}\n\nAnswer with the most relevant, current findings. Cite every source as its full URL. If you cannot find anything, say so.` }],
        workspace,
      );
      return answer.slice(0, MAX_CHARS);
    },
  };
}
