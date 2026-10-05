import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';

/** Normalizes paths to POSIX separators even on Windows hosts. */
function normalized(rel: string) {
  return rel.split(sep).join('/');
}

export async function safePath(workspace: string, input: string) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('path is required');
  const base = await realpath(workspace);
  const candidate = resolve(base, input);
  const rel = normalized(relative(base, candidate));
  if (rel === '..' || rel.startsWith('../')) throw new Error('Path is outside workspace');
  try {
    const actual = normalized(relative(base, await realpath(candidate)));
    if (actual === '..' || actual.startsWith('../')) throw new Error('Symlink escapes workspace');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  return candidate;
}

const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  [/(^|\s)rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)/i, 'recursive/forced rm'],
  [/(^|\s)sudo(\s|$)/i, 'sudo'],
  [/(^|\s)(mkfs(\.\w+)?|shutdown|reboot|halt|poweroff)(\s|$)/i, 'destructive system command'],
  [/(^|\s)dd\s+if=/i, 'dd'],
  [/(^|\s)(curl|wget)\b[^|;&]*\|\s*(ba)?sh/i, 'remote script piped to shell'],
  [/>\s*\/dev\/(sd|nvme|disk)/i, 'writing to a block device'],
  [/git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force|push\s+-f)/i, 'destructive git command'],
  [/git\s+push(\s+|"|'|$)/i, 'git push'],
  [/:\(\)\s*\{.*\};\s*:/i, 'fork bomb'],
  [/(^|\s)npm\s+publish(\s|$)/i, 'npm publish'],
];

export function dangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some(([re]) => re.test(command));
}

export function dangerousReason(command: string): string | null {
  for (const [re, why] of DANGEROUS_PATTERNS) if (re.test(command)) return why;
  return null;
}
