#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { join } from 'node:path';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  loadConfig, saveConfig, loadProjectInstructions, configPath,
  loadApiKey, saveApiKey, clearApiKey, maskKey, type Config,
} from '../config/config.js';
import { makeTools, ChangeJournal } from '../tools/tools.js';
import { runAgentTurn, emptyState, type AgentState } from '../agent/agent.js';
import { fetchModels } from '../providers/openrouter/models.js';

const COMMANDS = [
  ['help', 'list of commands'],
  ['api [key|remove]', 'set, show or remove the OpenRouter API key'],
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

const workspace = process.cwd();
const projectInstructions = await loadProjectInstructions(workspace);
let config = await loadConfig();

// API key: env var wins; otherwise use the key saved with /api <key>.
if (!process.env.OPENROUTER_API_KEY) {
  const stored = await loadApiKey();
  if (stored) process.env.OPENROUTER_API_KEY = stored;
}

let running = true;
let lastCtrlC = 0;
let abort: AbortController | null = null;
let state: AgentState = emptyState(new ChangeJournal());
let sessionId: string | null = null;
let sessionFirstTask = '';
const pricingCache = new Map<string, { in: number; out: number }>();

const rl = createInterface({
  input, output,
  completer: (line: string): [string[], string] => {
    const names = COMMANDS.map(([c]) => '/' + c).filter(c => c.startsWith(line));
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
      });
    } else pricingCache.set(config.model, { in: 0, out: 0 });
  } catch { pricingCache.set(config.model, { in: 0, out: 0 }); }
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
  if (!key) { console.log('Usage: /set <key> <value>. Keys: temperature, maxIterations, maxHistoryTurns, maxSubagentIterations, fileReadLimit, toolTimeoutMs, maxToolResultChars, budget'); return; }
  switch (key) {
    case 'temperature': case 'maxIterations': case 'maxHistoryTurns': case 'maxSubagentIterations': case 'fileReadLimit': case 'toolTimeoutMs': case 'maxToolResultChars': case 'budget':
      num(key as keyof Config); break;
    case 'permissionMode':
      if (['readonly', 'ask', 'auto'].includes(value)) config = { ...config, permissionMode: value as Config['permissionMode'] };
      break;
    default: console.log(PALETTE.red(`✗ Unknown key: ${key}`)); return;
  }
  await saveConfig(config);
  console.log(`${PALETTE.green('✓')} ${key} = ${(config as any)[key]}`);
}

const SUMMARIZE = 'Summarize this conversation so work can continue: the user goal, files touched and changes made, decisions, current state and next steps. Be concise (max 200 words).';

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

async function handleCommand(raw: string) {
  const [cmd, ...args] = raw.slice(1).split(/\s+/);
  switch (cmd) {
    case 'exit': case 'quit': running = false; return;
    case 'help':
      for (const [c, d] of COMMANDS) console.log(`  ${PALETTE.cyan('/' + c.padEnd(18))} ${d}`);
      return;
    case 'api': await cmdApi(args); return;
    case 'new':
      state = emptyState(new ChangeJournal()); sessionId = null; sessionFirstTask = '';
      console.log(`${PALETTE.green('✓')} New conversation (clean context)`);
      return;
    case 'resume': await cmdResume(); return;
    case 'model': await cmdModel(args); return;
    case 'set': await cmdSet(args); return;
    case 'permissions':
      if (args[0] && ['readonly', 'ask', 'auto'].includes(args[0])) { config = { ...config, permissionMode: args[0] as Config['permissionMode'] }; await saveConfig(config); }
      console.log(`Permissions: ${config.permissionMode}`);
      return;
    case 'undo': console.log(await state.journal.undo()); return;
    case 'agents':
      console.log(`Subagents: the main agent can delegate subtasks with the ${PALETTE.bold('task')} tool.
  Each subagent:
  · Has its own conversation (it never sees this history) and its own /undo.
  · Uses the same model and permission mode as the current session.
  · Cannot launch more subagents or use think.
  · Returns a single final report to the main agent.

  Ideal for: exploring code, investigating alternatives in parallel,
  or running independent subtasks without polluting the main context.`);
      return;
    case 'compact': await cmdCompact(); return;
    case 'config': console.log(config, '\nconfig:', configPath()); return;
    case 'clear': output.write('\x1b[2J\x1b[H'); return;
    case 'status':
      console.log({ workspace, model: config.model, permission: config.permissionMode, messages: state.messages.length });
      return;
    case 'cost': {
      await loadPricing();
      const c = estimateCost(state.usage);
      console.log(`Input: ${state.usage.inputTokens ?? '—'} | Output: ${state.usage.outputTokens ?? '—'} | Reasoning: ${state.usage.reasoningTokens ?? '—'} | Cached: ${state.usage.cachedTokens ?? '—'}`);
      console.log(c != null ? `Estimated cost: $${c.toFixed(4)}` : PALETTE.gray('No pricing for ' + config.model));
      return;
    }
    default:
      console.log('Unknown command. Use /help.');
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

  try {
    await loadPricing();
    console.log(PALETTE.gray('─'.repeat(55)));
    const tools = makeTools(workspace, config.permissionMode, approve, state.journal, config, {
      config,
      signal,
      projectInstructions,
      events: {
        onSubagentStart: (id, prompt, model) => output.write(`\n${PALETTE.magenta('⏺ subagent')} ${PALETTE.bold(id)} ${PALETTE.gray(`(${model}) → ${prompt.slice(0, 110)}`)}\n`),
        onSubagentTool: (id, name, line, ok) => output.write(`  ${PALETTE.magenta('│')} ${ok ? PALETTE.green('✓') : PALETTE.red('✗')} ${PALETTE.gray(`${name}: ${line}`.slice(0, 140))}\n`),
        onSubagentEnd: (id, r) => output.write(`${PALETTE.magenta('│')} ${PALETTE.gray(`${id} finished: ${r.report.split('\n').length}-line report`)}\n`),
      },
    });
    const result = await runAgentTurn(userInput, workspace, config, tools, state, {
      signal,
      onDelta: t => { if (!gotFirst) { gotFirst = true; output.write('\n'); } chars += t.length; title(`Generating ~${Math.ceil(chars / 4)} tok`); output.write(t); },
      onToolStart: (name, args) => { gotFirst = true; output.write(`\n${PALETTE.cyan('⏺')} ${PALETTE.bold(name)} ${PALETTE.gray(args.slice(0, 120))}\n`); },
      onToolEnd: (name, res) => { const line = res.split('\n')[0]; output.write(`  ${res.startsWith('ERROR') ? PALETTE.red('✗') : PALETTE.green('✓')} ${PALETTE.gray(line.slice(0, 140))}\n`); void name; },
      onUsage: u => { const c = estimateCost(u); title(`$${c != null ? c.toFixed(4) : '~' + u.outputTokens + ' tok'}`); },
    }, projectInstructions);
    await saveSession(result);
    const c = estimateCost(result.usage);
    console.log(`\n\n${PALETTE.gray(`[${result.usage.outputTokens ?? '?'} tok out${c != null ? ` · ~$${c.toFixed(4)}` : ''} · /undo reverts changes · /cost details]`)}`);
  } catch (e: any) {
    if (e?.name === 'AbortError' || signal.aborted) {
      output.write(`\n${PALETTE.yellow('● Task cancelled — context kept, you can continue with another instruction')}\n`);
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
  const tools = makeTools(workspace, config.permissionMode, approve, journal, config, { config, projectInstructions });
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
  if (line.startsWith('/')) { try { await handleCommand(line); } catch (e: any) { console.error(PALETTE.red('✗ ' + (e?.message ?? e))); } continue; }
  if (!process.env.OPENROUTER_API_KEY) { console.error(PALETTE.red('✗ No OpenRouter API key. Run /api sk-or-... (get one at https://openrouter.ai/keys)')); continue; }
  if (!sessionFirstTask) sessionFirstTask = line;
  await runTask(line);
}
rl.close();
