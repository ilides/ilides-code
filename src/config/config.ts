import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PermissionMode = 'readonly' | 'ask' | 'auto';

export interface Config {
  provider: string;
  model: string;
  permissionMode: PermissionMode;
  maxIterations: number;
  temperature: number;
  stream: boolean;
  budget?: number;                 // max USD per task (0 = unlimited)
  maxSubagentIterations: number;   // iteration cap for one subagent run
  maxHistoryTurns: number;         // user/assistant turns kept (tool msgs included)
  fileReadLimit: number;           // max lines per read_file
  toolTimeoutMs: number;           // default timeout for terminal_exec
  maxToolResultChars: number;      // tool result truncation limit
  autoCompact: boolean;            // summarize history automatically near the context limit
  checkpoints: boolean;            // snapshot the workspace before each task (for /rewind)
}

const dir = join(homedir(), '.ilides');
const file = join(dir, 'config.json');
const authFile = join(dir, 'auth.json');

export const defaults: Config = {
  provider: 'openrouter',
  model: 'openai/gpt-4o-mini',
  permissionMode: 'ask',
  maxIterations: 40,
  temperature: 0,
  stream: true,
  budget: 0,
  maxSubagentIterations: 15,
  maxHistoryTurns: 40,
  fileReadLimit: 400,
  toolTimeoutMs: 120_000,
  maxToolResultChars: 12_000,
  autoCompact: true,
  checkpoints: true,
};

export async function loadConfig(): Promise<Config> {
  try {
    return { ...defaults, ...JSON.parse(await readFile(file, 'utf8')) };
  } catch {
    return { ...defaults };
  }
}

export async function saveConfig(c: Config) {
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(c, null, 2) + '\n');
}

export function configPath() {
  return file;
}

/** API key stored by `/api <key>` (file mode 600, never committed). */
export async function loadApiKey(): Promise<string | null> {
  try {
    const j = JSON.parse(await readFile(authFile, 'utf8'));
    const k = j?.openrouterApiKey;
    return typeof k === 'string' && k.trim() ? k.trim() : null;
  } catch {
    return null;
  }
}

export async function saveApiKey(key: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(authFile, JSON.stringify({ openrouterApiKey: key.trim() }, null, 2) + '\n', { mode: 0o600 });
  try { await chmod(authFile, 0o600); } catch { /* best effort on exotic fs */ }
}

export async function clearApiKey(): Promise<void> {
  try { await unlink(authFile); } catch { /* already gone */ }
}

export function maskKey(key: string): string {
  if (key.length <= 12) return '••••••••';
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** Project instructions file (ILIDES.md), the equivalent of CLAUDE.md. */
export async function loadProjectInstructions(workspace: string): Promise<string | null> {
  for (const name of ['ILIDES.md', 'ilides.md']) {
    try {
      const text = await readFile(join(workspace, name), 'utf8');
      return text.trim() || null;
    } catch { /* not present */ }
  }
  return null;
}
