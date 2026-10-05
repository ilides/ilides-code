import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

/** Lifecycle hooks: user shell commands run on agent events (Claude Code-style). */
export interface Hooks {
  PreToolUse?: string[];    // before a tool runs; non-zero exit BLOCKS the tool
  PostToolUse?: string[];   // after a tool runs (e.g. auto-format)
  Stop?: string[];          // after the agent finishes a turn
}

export interface HookContext {
  workspace: string;
  tool?: string;
  input?: unknown;
  output?: string;
}

export interface HookOutcome {
  blocked: boolean;
  reason?: string;
  notes: string[];
}

const EVENT_KEYS: Array<keyof Hooks> = ['PreToolUse', 'PostToolUse', 'Stop'];

async function readHooksFile(path: string): Promise<Hooks> {
  try {
    const j = JSON.parse(await readFile(path, 'utf8'));
    const out: Hooks = {};
    for (const k of EVENT_KEYS) if (Array.isArray(j?.[k])) out[k] = j[k].filter((x: any) => typeof x === 'string');
    return out;
  } catch { return {}; }
}

/** Merges ~/.ilides/hooks.json (global) with <workspace>/.ilides/hooks.json (project). */
export async function loadHooks(workspace: string): Promise<Hooks> {
  const global = await readHooksFile(join(homedir(), '.ilides', 'hooks.json'));
  const local = await readHooksFile(join(workspace, '.ilides', 'hooks.json'));
  const merged: Hooks = {};
  for (const k of EVENT_KEYS) {
    const all = [...(global[k] ?? []), ...(local[k] ?? [])];
    if (all.length) merged[k] = all;
  }
  return merged;
}

function runOne(cmd: string, ctx: HookContext, timeoutMs = 10_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(resolve => {
    const p = spawn('bash', ['-lc', cmd], {
      cwd: ctx.workspace,
      windowsHide: true,
      env: {
        ...process.env,
        ILIDES_WORKSPACE: ctx.workspace,
        ILIDES_TOOL_NAME: ctx.tool ?? '',
        ILIDES_TOOL_INPUT: JSON.stringify(ctx.input ?? null),
        ILIDES_TOOL_OUTPUT: (ctx.output ?? '').slice(0, 20_000),
      },
    });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } resolve({ code: null, out, err: err + '\n[hook timeout]' }); }, timeoutMs);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/**
 * Runs all hooks for an event.
 * PreToolUse: any non-zero exit blocks the tool (reason = stderr/stdout).
 * PostToolUse/Stop: failures are collected as notes but never block.
 */
export async function runHooks(event: keyof Hooks, hooks: Hooks, ctx: HookContext): Promise<HookOutcome> {
  const cmds = hooks[event];
  if (!cmds?.length) return { blocked: false, notes: [] };
  const notes: string[] = [];
  for (const cmd of cmds) {
    const { code, out, err } = await runOne(cmd, ctx);
    if (event === 'PreToolUse' && code !== 0) {
      const reason = (err || out || `hook exited with ${code ?? 'timeout'}`).trim().slice(0, 500);
      return { blocked: true, reason, notes };
    }
    if (code !== 0 && code !== null) notes.push(`hook "${cmd.slice(0, 60)}" exited ${code}: ${(err || out).trim().slice(0, 200)}`);
  }
  return { blocked: false, notes };
}
