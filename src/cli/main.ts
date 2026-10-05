#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { join } from 'node:path';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  loadConfig, saveConfig, loadProjectInstructions, configPath,
  loadApiKey, saveApiKey, clearApiKey, maskKey, type Config,
} from '../config/config.js';
import { makeTools, ChangeJournal, type ToolDef } from '../tools/tools.js';
import { runAgentTurn, emptyState, type AgentState } from '../agent/agent.js';
import { fetchModels } from '../providers/openrouter/models.js';
import { loadCustomCommands, expandCommand } from './commands.js';
import { buildRepoMap } from '../tools/repoMap.js';
import { snapshot as ckSnapshot, listCheckpoints, rewind as ckRewind } from '../tools/checkpoint.js';
import { loadMcpTools } from '../tools/mcp.js';
import { completeOnce } from '../agent/complete.js';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

const COMMANDS = [
  ['help', 'list of commands'],
  ['api [key|remove]', 'set, show or remove the OpenRouter API key'],
  ['plan', 'toggle plan mode: explore read-only, present a plan, implement after approval'],
  ['diff [path]', 'show pending changes (git diff)'],
  ['commit [msg]', 'commit with an AI-generated message'],
  ['checkpoints', 'list workspace snapshots'],
  ['rewind [id]', 'restore the workspace to a checkpoint'],
  ['new', 'new conversation (resets context)'],
  ['agents', 'how subagents work (the task tool)'],
  ['resume', 'resume a previous session'],
  ['model [id|nº]', 'view or change the OpenRouter model'],
  ['set <key> <value>', 'settings: temperature, maxIterations, permissionMode, budget, …'],
  ['permissions [mode]', 'readonly | ask | auto'],
  ['undo', 'undo the last file change'],
  ['cost', 'tokens and estimated cost of this conversation'],
  ['compact', 'summarize history to free up context'],
  ['config', 'show full configuration'],
  ['status', 'workspace, model and permission mode'],
  ['clear', 'clear the screen'],
  ['exit', 'exit (also quit or Ctrl+C ×2)'],
] as const;

const PALETTE = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

function parseArgs(argv: string[]) {
  const o: { prompt: string[]; model?: string; yes: boolean; readonly: boolean; help: boolean } = { prompt: [], yes: false, readonly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '-p' || a === '--prompt')) { const v = argv[++i]; if (v) o.prompt.push(v); }
    else if (a === '-m' || a === '--model') o.model = argv[++i];
    else if (a === '-y' || a === '--yes') o.yes = true;
    else if (a === '--readonly') o.readonly = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else o.prompt.push(a);
  }
  return o;
}

// Show help before any heavy initialization.
if (parseArgs(process.argv.slice(2)).help) {
  console.log(`ILIDES Code — coding agent for the terminal

Usage:
  ilides                     interactive session
  ilides -p "task"           run one task and exit (non-interactive)
  ilides -p "task" -y        non-interactive, auto-approve writes and commands

Options:
  -p, --prompt <text>   task to run in non-interactive mode
  -m, --model <id>      OpenRouter model (e.g. openai/gpt-4o-mini)
  -y, --yes             automatically approve writes and commands
      --readonly        read-only mode
  -h, --help            show this help

API key: set it once with /api sk-or-... (or export OPENROUTER_API_KEY).
In interactive mode type /help to see the commands.`);
  process.exit(0);
}

const workspace = process.cwd();
const ilidesMd = await loadProjectInstructions(workspace);
const repoMap = await buildRepoMap(workspace);
const projectInstructions = [ilidesMd, repoMap].filter(Boolean).join('\n\n') || null;
let config = await loadConfig();

// API key: env var wins; otherwise use the key saved with /api <key>.
if (!process.env.OPENROUTER_API_KEY) {
  const stored = await loadApiKey();
  if (stored) process.env.OPENROUTER_API_KEY = stored;
}

// MCP servers (.ilides/mcp.json) — tools appear as mcp_<server>_<tool>.
let mcpTools: Record<string, ToolDef> = {};
try { mcpTools = await loadMcpTools(workspace); } catch { mcpTools = {}; }

// Custom slash commands (.ilides/commands/*.md and ~/.ilides/commands/*.md).
const customCommands = await loadCustomCommands(workspace);

let planMode = false;
let lastPromptTokens = 0;
let budgetHit = false;
let running = true;
let lastCtrlC = 0;
let abort: AbortController | null = null;
let state: AgentState = emptyState(new ChangeJournal());
let sessionId: string | null = null;
let sessionFirstTask = '';
const pricingCache = new Map<string, { in: number; out: number; context?: number }>();

const rl = createInterface({
  input, output,
  completer: (line: string): [string[], string] => {
    const names = [...COMMANDS.map(([c]) => '/' + c), ...[...customCommands.keys()].map(k => '/' + k)].filter(c => c.startsWith(line));
    return [names.length ? names : [], line];
  },
});
rl.on('SIGINT', () => {
  const now = Date.now();
  if (abort) {
    abort.abort();
    output.write(PALETTE.yellow('\n· cancelling task…\n'));
  } else if (now - lastCtrlC < 1500) {
    running = false;
    rl.close();
  } else {
    lastCtrlC = now;
    output.write(PALETTE.gray('\n· press Ctrl+C again to exit · /new resets the context\n'));
    rl.prompt(true);
  }
});

const title = (s: string) => process.stdout.write(`\x1b]0;ILIDES Code — ${s}\x07`);
const banner = () => {
  const key = process.env.OPENROUTER_API_KEY;
  const keyLine = key
    ? `${PALETTE.green('✓')} ${maskKey(key)}`
    : `${PALETTE.yellow('✗ not set')} ${PALETTE.gray('— run /api <key> (openrouter.ai/keys)')}`;
  console.log(`
${PALETTE.cyan('╭─ ILIDES CODE ' + '─'.repeat(38))}
${PALETTE.cyan('│')} ${PALETTE.bold('Model')}     ${config.model}
${PALETTE.cyan('│')} ${PALETTE.bold('API key')}   ${keyLine}
${PALETTE.cyan('│')} ${PALETTE.bold('Workspace')}  ${workspace}
${PALETTE.cyan('│')} ${PALETTE.bold('Permissions')}   ${config.permissionMode}   ${PALETTE.gray('(/help for commands)')}
${PALETTE.cyan('╰' + '─'.repeat(53))}
`);
};

const sessionsDir = () => join(workspace, '.ilides', 'sessions');

async function saveSession(state_: AgentState) {
  await mkdir(sessionsDir(), { recursive: true });
  if (!sessionId) sessionId = crypto.randomUUID().slice(0, 8);
  const data = {
    id: sessionId,
    timestamp: new Date().toISOString(),
    model: config.model,
    workspace,
    firstTask: sessionFirstTask,
    messages: state_.messages,
    usage: state_.usage,
  };
  await writeFile(join(sessionsDir(), sessionId + '.json'), JSON.stringify(data, null, 2));
}

async function listSessions() {
  try {
    const files = (await readdir(sessionsDir())).filter(f => f.endsWith('.json')).sort().reverse();
    const out = [];
    for (const f of files) {
      try {
        const j = JSON.parse(await readFile(join(sessionsDir(), f), 'utf8'));
        out.push({ id: j.id, when: j.timestamp, task: (j.firstTask ?? j.task ?? '').slice(0, 70), model: j.model });
      } catch { /* corrupt file, skip */ }
    }
    return out;
  } catch { return []; }
}

function estimateCost(u: { inputTokens: number | null; outputTokens: number | null }) {
  const p = pricingCache.get(config.model);
  if (!p || u.inputTokens == null || u.outputTokens == null) return null;
  return u.inputTokens * p.in + u.outputTokens * p.out;
}

async function loadPricing() {
  if (pricingCache.has(config.model)) return;
  try {
    const models = await fetchModels();
    const m = models.find(x => x.id === config.model);
    if (m?.pricing) {
      pricingCache.set(config.model, {
        in: parseFloat(m.pricing.prompt ?? '0') || 0,
        out: parseFloat(m.pricing.completion ?? '0') || 0,
        context: m.context_length ?? 0,
      });
    } else pricingCache.set(config.model, { in: 0, out: 0, context: m?.context_length ?? 0 });
  } catch { pricingCache.set(config.model, { in: 0, out: 0 }); }
}

/** Context usage of the latest request vs the model window, in percent. */
function ctxPct(): number | null {
  const win = pricingCache.get(config.model)?.context;
  if (!win || !lastPromptTokens) return null;
  return Math.min(100, Math.round((lastPromptTokens / win) * 100));
}

async function cmdApi(args: string[]) {
  const sub = args.join(' ').trim();
  if (!sub) {
    const key = process.env.OPENROUTER_API_KEY;
    if (key) {
      console.log(`${PALETTE.green('✓')} OpenRouter API key: ${maskKey(key)} (${(await loadApiKey()) ? 'saved in ~/.ilides/auth.json' : 'from environment'})`);
      console.log(PALETTE.gray('  Change it: /api sk-or-... · Remove it: /api remove'));
    } else {
      console.log(`${PALETTE.yellow('✗')} No OpenRouter API key.`);
      console.log(PALETTE.gray('  Get one at https://openrouter.ai/keys and run: /api sk-or-...'));
    }
    return;
  }
  if (/^(remove|clear|logout|delete)$/i.test(sub)) {
    await clearApiKey();
    delete process.env.OPENROUTER_API_KEY;
    console.log(`${PALETTE.green('✓')} API key removed (it will not be loaded on the next start)`);
    return;
  }
  if (sub.length < 20) {
    console.log(PALETTE.red('✗ That does not look like an OpenRouter key (too short). Get one at https://openrouter.ai/keys'));
    return;
  }
  await saveApiKey(sub);
  process.env.OPENROUTER_API_KEY = sub;
  console.log(`${PALETTE.green('✓')} API key saved to ~/.ilides/auth.json (permissions 600): ${maskKey(sub)}`);
}

async function cmdModel(args: string[]) {
  if (args[0]) {
    config = { ...config, model: args[0] };
    await saveConfig(config);
    console.log(`${PALETTE.green('✓')} Model: ${config.model}`);
    return;
  }
  console.log(PALETTE.gray('● Querying the OpenRouter catalog…'));
  const ms = await fetchModels();
  const page = ms.slice(0, 40);
  page.forEach((m, i) => console.log(`${String(i + 1).padStart(3)}. ${m.id}`));
  console.log(PALETTE.gray(`… ${ms.length} models in total. Type an ID directly: /model openai/gpt-4o`));
  const q = (await rl.question('Number or ID (Enter to cancel): ')).trim();
  if (!q) return;
  const m = ms[Number(q) - 1] ?? ms.find(x => x.id === q);
  if (m) {
    config = { ...config, model: m.id };
    await saveConfig(config);
    console.log(`${PALETTE.green('✓')} Model selected: ${m.id}`);
  } else console.log(PALETTE.red('✗ Not found'));
}

async function cmdResume() {
  const sessions = await listSessions();
  if (!sessions.length) { console.log('No saved sessions.'); return; }
  sessions.slice(0, 10).forEach((s, i) =>
    console.log(`${String(i + 1).padStart(3)}. ${PALETTE.gray(s.when.slice(0, 16).replace('T', ' '))} ${s.task} ${PALETTE.gray(`(${s.id} · ${s.model})`)}`));
  const q = (await rl.question('Number or ID (Enter to cancel): ')).trim();
  if (!q) return;
  const pick = sessions[Number(q) - 1] ?? sessions.find(s => s.id === q);
  if (!pick) { console.log(PALETTE.red('✗ Session not found')); return; }
  const j = JSON.parse(await readFile(join(sessionsDir(), pick.id + '.json'), 'utf8'));
  state = { messages: j.messages ?? [], usage: j.usage ?? { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null }, journal: new ChangeJournal() };
  sessionId = j.id; sessionFirstTask = j.firstTask ?? j.task ?? '';
  console.log(`${PALETTE.green('✓')} Session resumed: ${sessionFirstTask}`);
}

async function cmdSet(args: string[]) {
  const [key, ...rest] = args;
  const value = rest.join(' ');
  const num = (k: keyof Config) => { const v = Number(value); if (Number.isFinite(v)) config = { ...config, [k]: v } as Config; };
  if (!key) { console.log('Usage: /set <key> <value>. Keys: temperature, maxIterations, maxHistoryTurns, maxSubagentIterations, fileReadLimit, toolTimeoutMs, maxToolResultChars, budget, autoCompact, checkpoints, permissionMode'); return; }
  switch (key) {
    case 'temperature': case 'maxIterations': case 'maxHistoryTurns': case 'maxSubagentIterations': case 'fileReadLimit': case 'toolTimeoutMs': case 'maxToolResultChars': case 'budget':
      num(key as keyof Config); break;
    case 'autoCompact': case 'checkpoints':
      config = { ...config, [key]: /^(1|true|on|yes)$/i.test(value) } as Config; break;
    case 'permissionMode':
      if (['readonly', 'ask', 'auto'].includes(value)) config = { ...config, permissionMode: value as Config['permissionMode'] };
      break;
    default: console.log(PALETTE.red(`✗ Unknown key: ${key}`)); return;
  }
  await saveConfig(config);
  console.log(`${PALETTE.green('✓')} ${key} = ${(config as any)[key]}`);
}

const SUMMARIZE = 'Summarize this conversation so work can continue: the user goal, files touched and changes made, decisions, current state and next steps. Be concise (max 200 words).';

const runGit = (argv: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const p = spawn('git', argv, { cwd: workspace, windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } resolve({ code: null, out, err: err + '\n[timeout]' }); }, 60_000);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });

const PLAN_ALLOWED = new Set(['read_file', 'list_files', 'glob', 'search', 'git_status', 'think', 'todo_write', 'web_fetch', 'web_search', 'view_image', 'exit_plan_mode']);

/** Plan mode approval tool (Claude Code-style Enter/ExitPlanMode). */
function makePlanTool(): ToolDef {
  return {
    description: 'Present your implementation plan and request approval. Call it once exploration is complete and you are ready to act; the user approves (then implement) or rejects (stay in plan mode and refine).',
    parameters: {
      type: 'object', properties: {
        plan: { type: 'string', description: 'Full plan in markdown: goal, files to change, concrete steps, risks.' },
      }, required: ['plan'], additionalProperties: false,
    },
    run: async ({ plan }) => {
      output.write(`\n${PALETTE.cyan('┌─ PLAN')}\n${String(plan).split('\n').map(l => `${PALETTE.cyan('│')} ${l}`).join('\n')}\n${PALETTE.cyan('└' + '─'.repeat(50))}\n`);
      const ans = (await rl.question('Approve plan and start implementing? [y/N] ')).trim();
      if (/^y(es)?$/i.test(ans)) { planMode = false; return 'PLAN APPROVED. Execute the plan now.'; }
      return 'PLAN REJECTED. Stay in plan mode: keep exploring with read-only tools, do not edit anything.';
    },
  };
}

async function cmdDiff(args: string[]) {
  let r = await runGit(args.length ? ['diff', 'HEAD', '--', ...args] : ['diff', 'HEAD']);
  if (r.code !== 0) r = await runGit(args.length ? ['diff', '--', ...args] : ['diff']);
  const out = (r.out || '').trim();
  if (!out) { console.log('(no pending changes)'); return; }
  console.log(out.slice(0, 40_000) + (out.length > 40_000 ? `\n…[${out.length - 40_000} more chars]` : ''));
}

async function cmdCommit(args: string[]) {
  const status = await runGit(['status', '--short']);
  if (!status.out.trim()) { console.log('Nothing to commit.'); return; }
  let msg = args.join(' ').trim();
  if (!msg) {
    let diff = (await runGit(['diff', 'HEAD']));
    if (diff.code !== 0 || !diff.out) diff = await runGit(['diff']);
    console.log(PALETTE.gray('● Generating commit message…'));
    try {
      msg = await completeOnce(
        { ...config, temperature: 0.2 },
        [
          { role: 'system', content: 'You write git commit messages in conventional-commits style (type(scope): summary). Answer with the message only, first line max 72 chars. No quotes, no explanation.' },
          { role: 'user', content: `Status:\n${status.out.slice(0, 4000)}\n\nDiff:\n${diff.out.slice(0, 30_000)}` },
        ],
        workspace,
      );
    } catch (e: any) { console.error(PALETTE.red('✗ Could not generate a message: ' + (e?.message ?? e))); return; }
  }
  console.log(`\n${PALETTE.bold(msg)}\n`);
  const ok = /^y(es)?$/i.test((await rl.question('Commit? [y/N] ')).trim());
  if (!ok) { console.log('Cancelled.'); return; }
  const add = await runGit(['add', '-A']);
  if (add.code !== 0) { console.error(PALETTE.red(add.err || 'git add failed')); return; }
  const c = await runGit(['commit', '-m', msg]);
  if (c.code !== 0) console.error(PALETTE.red(c.err || c.out));
  else console.log(`${PALETTE.green('✓')} ${c.out.trim().split('\n').pop() ?? 'committed'}`);
}

async function cmdCheckpoints() {
  const list = await listCheckpoints(workspace);
  if (!list.length) { console.log('No checkpoints yet (enable with /set checkpoints true).'); return; }
  list.forEach((c, i) => console.log(`${String(i + 1).padStart(3)}. ${PALETTE.gray(c.id)} (${c.files} files)`));
  console.log(PALETTE.gray('Restore with /rewind [id]'));
}

async function cmdRewind(args: string[]) {
  const list = await listCheckpoints(workspace);
  const id = args[0] ?? list[0]?.id;
  if (!id || !list.some(c => c.id === id)) { console.log(PALETTE.red('✗ Checkpoint not found. See /checkpoints.')); return; }
  const confirm = /^y(es)?$/i.test((await rl.question(`Rewind workspace to ${id}? [y/N] `)).trim());
  if (!confirm) { console.log('Cancelled.'); return; }
  try {
    const r = await ckRewind(workspace, id);
    console.log(`${PALETTE.green('✓')} Restored ${r.restored.length} files to checkpoint ${id}`);
    if (r.extras.length) {
      console.log(PALETTE.gray('Files created after the checkpoint:') + '\n' + r.extras.slice(0, 20).map(f => '  ' + f).join('\n') + (r.extras.length > 20 ? `\n  … ${r.extras.length - 20} more` : ''));
      const del = /^y(es)?$/i.test((await rl.question(`Delete these ${r.extras.length} files? [y/N] `)).trim());
      if (del) {
        for (const f of r.extras) await rm(join(workspace, f), { force: true });
        console.log(`${PALETTE.green('✓')} Deleted ${r.extras.length} files`);
      }
    }
  } catch (e: any) { console.error(PALETTE.red('✗ ' + (e?.message ?? e))); }
}

async function cmdCompact() {
  const keep = 6;
  if (state.messages.length <= keep + 1) { console.log('History too short to compact.'); return; }
  console.log(PALETTE.gray('● Compacting history…'));
  const sys = state.messages[0];
  const old = state.messages.slice(1, -keep);
  const recent = state.messages.slice(-keep);
  const summary = await runAgentTurn(SUMMARIZE, workspace, { ...config, maxIterations: 1 }, {}, { messages: [{ role: 'user', content: old.map(m => JSON.stringify(m)).join('\n').slice(0, 60_000) }], usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null }, journal: state.journal }, {});
  const summaryText = [...summary.messages].reverse().find(m => m.role === 'assistant')?.content ?? '(no summary)';
  state.messages = [sys, { role: 'user', content: `[Summary of the earlier work]\n${summaryText}` }, ...recent];
  await saveSession(state);
  console.log(`${PALETTE.green('✓')} History compacted: ${state.messages.length} messages`);
}

/** Returns an expanded custom-command prompt to run, or null. */
async function handleCommand(raw: string): Promise<string | null> {
  const [cmd, ...args] = raw.slice(1).split(/\s+/);
  switch (cmd) {
    case 'exit': case 'quit': running = false; return null;
    case 'help':
      for (const [c, d] of COMMANDS) console.log(`  ${PALETTE.cyan('/' + c.padEnd(18))} ${d}`);
      if (customCommands.size) {
        console.log(`\n  ${PALETTE.bold('Custom commands')} (from .ilides/commands/*.md)`);
        for (const [n, c] of customCommands) console.log(`  ${PALETTE.cyan('/' + n.padEnd(18))} ${c.description}`);
      }
      return null;
    case 'api': await cmdApi(args); return null;
    case 'plan':
      planMode = !planMode;
      console.log(planMode
        ? `${PALETTE.green('✓')} Plan mode ON — explore with read-only tools, then call exit_plan_mode with your plan.`
        : `${PALETTE.green('✓')} Plan mode OFF — full toolset available.`);
      return null;
    case 'diff': await cmdDiff(args); return null;
    case 'commit': await cmdCommit(args); return null;
    case 'checkpoints': await cmdCheckpoints(); return null;
    case 'rewind': await cmdRewind(args); return null;
    case 'new':
      state = emptyState(new ChangeJournal()); sessionId = null; sessionFirstTask = '';
      console.log(`${PALETTE.green('✓')} New conversation (clean context)`);
      return null;
    case 'resume': await cmdResume(); return null;
    case 'model': await cmdModel(args); return null;
    case 'set': await cmdSet(args); return null;
    case 'permissions':
      if (args[0] && ['readonly', 'ask', 'auto'].includes(args[0])) { config = { ...config, permissionMode: args[0] as Config['permissionMode'] }; await saveConfig(config); }
      console.log(`Permissions: ${config.permissionMode}`);
      return null;
    case 'undo': console.log(await state.journal.undo()); return null;
    case 'agents':
      console.log(`Subagents: the main agent can delegate subtasks with the ${PALETTE.bold('task')} tool.
  Each subagent:
  · Has its own conversation (it never sees this history) and its own /undo.
  · Uses the same model and permission mode as the current session.
  · Cannot launch more subagents or use think.
  · Returns a single final report to the main agent.

  Ideal for: exploring code, investigating alternatives in parallel,
  or running independent subtasks without polluting the main context.`);
      return null;
    case 'compact': await cmdCompact(); return null;
    case 'config': console.log(config, '\nconfig:', configPath()); return null;
    case 'clear': output.write('\x1b[2J\x1b[H'); return null;
    case 'status':
      console.log({ workspace, model: config.model, permission: config.permissionMode, planMode, context: ctxPct() != null ? `${ctxPct()}%` : 'n/a', messages: state.messages.length });
      return null;
    case 'cost': {
      if (args[0] === 'reset') {
        state.usage = emptyState(state.journal).usage;
        lastPromptTokens = 0;
        console.log(`${PALETTE.green('✓')} Usage counters reset (budget unchanged)`);
        return null;
      }
      await loadPricing();
      const c = estimateCost(state.usage);
      console.log(`Input: ${state.usage.inputTokens ?? '—'} | Output: ${state.usage.outputTokens ?? '—'} | Reasoning: ${state.usage.reasoningTokens ?? '—'} | Cached: ${state.usage.cachedTokens ?? '—'}`);
      console.log(c != null ? `Estimated cost: $${c.toFixed(4)}${config.budget ? ` / budget $${config.budget}` : ''}` : PALETTE.gray('No pricing for ' + config.model));
      return null;
    }
    default: {
      const custom = customCommands.get(cmd);
      if (custom) return expandCommand(custom, args.join(' '));
      console.log('Unknown command. Use /help.');
      return null;
    }
  }
}

const approve = async (a: string, d: string) =>
  /^y(es)?$/i.test(await rl.question(`\n${PALETTE.yellow('⚠ Allow')} ${PALETTE.bold(a)}: ${d}? [y/N] `));

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
async function runTask(userInput: string) {
  abort = new AbortController();
  const signal = abort.signal;
  let chars = 0, gotFirst = false;
  const spin = setInterval(() => {
    if (gotFirst) return;
    const f = SPINNER[Date.now() / 80 % SPINNER.length | 0];
    title(`Thinking ${f}`);
  }, 100);
  budgetHit = false;

  try {
    await loadPricing();
    if (config.budget && config.budget > 0) {
      const spent = estimateCost(state.usage);
      if (spent != null && spent >= config.budget) {
        console.error(PALETTE.red(`✗ Budget reached: $${spent.toFixed(4)} / $${config.budget} — task not started. Raise it: /set budget <usd> · clear usage: /cost reset`));
        return;
      }
    }
    if (config.checkpoints) {
      const ck = await ckSnapshot(workspace);
      if (ck) console.log(PALETTE.gray(`· checkpoint ${ck} saved — restore with /rewind`));
    }
    console.log(PALETTE.gray('─'.repeat(55)));
    let tools: Record<string, ToolDef> = {
      ...makeTools(workspace, config.permissionMode, approve, state.journal, config, {
        config,
        signal,
        projectInstructions,
        events: {
          onSubagentStart: (id, prompt, model) => output.write(`\n${PALETTE.magenta('⏺ subagent')} ${PALETTE.bold(id)} ${PALETTE.gray(`(${model}) → ${prompt.slice(0, 110)}`)}\n`),
          onSubagentTool: (id, name, line, ok) => output.write(`  ${PALETTE.magenta('│')} ${ok ? PALETTE.green('✓') : PALETTE.red('✗')} ${PALETTE.gray(`${name}: ${line}`.slice(0, 140))}\n`),
          onSubagentEnd: (id, r) => output.write(`${PALETTE.magenta('│')} ${PALETTE.gray(`${id} finished: ${r.report.split('\n').length}-line report`)}\n`),
        },
      }),
      ...mcpTools,
    };
    if (planMode) {
      tools = Object.fromEntries(Object.entries(tools).filter(([n]) => PLAN_ALLOWED.has(n)));
      tools.exit_plan_mode = makePlanTool();
    }
    const result = await runAgentTurn(userInput, workspace, config, tools, state, {
      signal,
      onDelta: t => { if (!gotFirst) { gotFirst = true; output.write('\n'); } chars += t.length; title(`Generating ~${Math.ceil(chars / 4)} tok`); output.write(t); },
      onToolStart: (name, args) => { gotFirst = true; output.write(`\n${PALETTE.cyan('⏺')} ${PALETTE.bold(name)} ${PALETTE.gray(args.slice(0, 120))}\n`); },
      onToolEnd: (name, res) => { const line = res.split('\n')[0]; output.write(`  ${res.startsWith('ERROR') ? PALETTE.red('✗') : PALETTE.green('✓')} ${PALETTE.gray(line.slice(0, 140))}\n`); void name; },
      onUsage: u => {
        const c = estimateCost(u);
        if (config.budget && config.budget > 0 && c != null && c >= config.budget) { budgetHit = true; abort?.abort(); }
        void c;
      },
      onContext: t => {
        lastPromptTokens = t;
        const c = estimateCost(state.usage);
        const pct = ctxPct();
        title(`${c != null ? '$' + c.toFixed(4) : '~' + (state.usage.outputTokens ?? '?') + ' tok'}${pct != null ? ` · ctx ${pct}%` : ''}`);
      },
    }, projectInstructions);
    await saveSession(result);
    const c = estimateCost(result.usage);
    const pct = ctxPct();
    console.log(`\n\n${PALETTE.gray(`[${result.usage.outputTokens ?? '?'} tok out${c != null ? ` · ~$${c.toFixed(4)}` : ''}${pct != null ? ` · ctx ${pct}%` : ''} · /undo reverts changes · /cost details]`)}`);
    if (config.autoCompact && pct != null && pct >= 85) {
      console.log(PALETTE.gray('● Auto-compact: context is nearly full'));
      await cmdCompact();
    }
  } catch (e: any) {
    if (e?.name === 'AbortError' || signal.aborted) {
      if (budgetHit) output.write(`\n${PALETTE.yellow('● Budget reached — task stopped. /set budget <usd> to raise it, /cost reset to clear usage.')}\n`);
      else output.write(`\n${PALETTE.yellow('● Task cancelled — context kept, you can continue with another instruction')}\n`);
      await saveSession(state);
    } else {
      console.error(`\n${PALETTE.red('✗ ' + (e?.message ?? String(e)))}`);
    }
  } finally {
    clearInterval(spin);
    abort = null;
    title(`ILIDES Code — ${config.model}`);
  }
}

const argvOpts = parseArgs(process.argv.slice(2));
if (argvOpts.help) {
  console.log(`ILIDES Code — coding agent for the terminal

Usage:
  ilides                     interactive session
  ilides -p "task"           run one task and exit (non-interactive)
  ilides -p "task" -y        non-interactive, auto-approve writes and commands

Options:
  -p, --prompt <text>   task to run in non-interactive mode
  -m, --model <id>      OpenRouter model (e.g. openai/gpt-4o-mini)
  -y, --yes             automatically approve writes and commands
      --readonly        read-only mode
  -h, --help            show this help

API key: set it once with /api sk-or-... (or export OPENROUTER_API_KEY).
In interactive mode type /help to see the commands.`);
  process.exit(0);
}
if (argvOpts.prompt.length) {
  const prompt = argvOpts.prompt.join(' ');
  if (argvOpts.model) { config = { ...config, model: argvOpts.model }; await saveConfig(config); }
  if (argvOpts.readonly) config = { ...config, permissionMode: 'readonly' };
  if (argvOpts.yes) config = { ...config, permissionMode: 'auto' };
  if (!process.env.OPENROUTER_API_KEY) {
    console.error(PALETTE.red('✗ No OpenRouter API key. Set one with /api sk-or-... in an interactive session, or export OPENROUTER_API_KEY.'));
    process.exit(1);
  }
  const journal = new ChangeJournal();
  const oneShot = emptyState(journal);
  if (config.checkpoints) await ckSnapshot(workspace);
  let tools: Record<string, ToolDef> = {
    ...makeTools(workspace, config.permissionMode, approve, journal, config, { config, projectInstructions }),
    ...mcpTools,
  };
  try {
    await runAgentTurn(prompt, workspace, config, tools, oneShot, {
      onDelta: t => process.stdout.write(t),
      onToolStart: (n, a) => process.stdout.write(`\n${PALETTE.cyan('⏺')} ${PALETTE.bold(n)} ${PALETTE.gray(a.slice(0, 120))}\n`),
      onToolEnd: (_n, r) => process.stdout.write(`  ${r.startsWith('ERROR') ? PALETTE.red('✗') : PALETTE.green('✓')} ${PALETTE.gray((r.split('\n')[0] ?? '').slice(0, 140))}\n`),
    }, projectInstructions);
    process.stdout.write('\n');
    process.exit(0);
  } catch (e: any) {
    console.error(`\n${PALETTE.red('✗ ' + (e?.message ?? String(e)))}`);
    process.exit(1);
  }
}

banner();
while (running) {
  let line: string;
  try { line = (await rl.question(PALETTE.cyan('❯ '))).trim(); }
  catch { break; }
  if (!line) continue;
  while (line.endsWith('\\')) line = line.slice(0, -1) + '\n' + (await rl.question('  ')).trimEnd();
  if (line.startsWith('/')) {
    try {
      const customPrompt = await handleCommand(line);
      if (customPrompt) { if (!sessionFirstTask) sessionFirstTask = line; await runTask(customPrompt); }
    } catch (e: any) { console.error(PALETTE.red('✗ ' + (e?.message ?? e))); }
    continue;
  }
  if (!process.env.OPENROUTER_API_KEY) { console.error(PALETTE.red('✗ No OpenRouter API key. Run /api sk-or-... (get one at https://openrouter.ai/keys)')); continue; }
  if (!sessionFirstTask) sessionFirstTask = line;
  await runTask(line);
}
rl.close();
