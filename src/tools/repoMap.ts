import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.ilides', '.freebuff', '.kilo', '.next', 'build', 'coverage', '__pycache__', '.venv']);

/**
 * Compact repository map (directory tree) injected into the system prompt,
 * inspired by Aider's repo map. Returns null when the tree is trivial.
 */
export async function buildRepoMap(workspace: string, opts: { maxDepth?: number; maxChars?: number } = {}): Promise<string | null> {
  const maxDepth = opts.maxDepth ?? 4;
  const maxChars = opts.maxChars ?? 3_500;
  const lines: string[] = [];

  const walk = async (dir: string, rel: string, depth: number) => {
    if (depth > maxDepth || lines.join('\n').length > maxChars) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }
    const sorted = entries
      .filter(e => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name));
    for (const e of sorted) {
      if (lines.join('\n').length > maxChars) { lines.push('  …'); return; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      const indent = '  '.repeat(depth);
      lines.push(`${indent}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) await walk(join(dir, e.name), r, depth + 1);
    }
  };

  await walk(workspace, '', 0);
  if (!lines.length) return null;
  const body = lines.join('\n');
  return `Repository map (structure):\n${body.slice(0, maxChars)}`;
}
