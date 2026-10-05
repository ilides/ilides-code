import { readFile, writeFile, unlink, readdir, stat, mkdir, rename, chmod, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, relative, isAbsolute } from 'node:path';
import { safePath, dangerous, dangerousReason } from './security.js';
import { runSubagent } from '../agent/subagents.js';
import type { SubagentEvents } from '../agent/subagents.js';
import type { Config } from '../config/config.js';

export type Approval = (action: string, detail: string) => Promise<boolean>;

export interface ToolResult { ok: boolean; output: string }

export interface ToolDef {
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  run: (args: any) => Promise<string>;
}

function trunc(s: string, max: number, label = 'output') {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[${label} truncated: ${s.length - max} chars omitted]`;
}

/** Change journal backing `/undo`. */
export class ChangeJournal {
  private undoStack: Array<() => Promise<string>> = [];
  async record(undo: () => Promise<string>) { this.undoStack.push(undo); }
  get canUndo() { return this.undoStack.length > 0; }
  async undo(): Promise<string> {
    const fn = this.undoStack.pop();
    if (!fn) return 'Nothing to undo.';
    return fn();
  }
}

export function makeTools(
  workspace: string,
  mode: 'readonly' | 'ask' | 'auto',
  approve: Approval,
  journal = new ChangeJournal(),
  limits = { fileReadLimit: 400, maxToolResultChars: 12_000, toolTimeoutMs: 120_000 },
  subagent: { config: Config; signal?: AbortSignal; projectInstructions?: string | null; events?: SubagentEvents } | null = null,
) {
  const taskSeq = { n: 1 };
  const signal = subagent?.signal;
  const subagentCtx = subagent;

  const guard = async (action: string, detail: string, write: boolean) => {
    if (mode === 'readonly' && write) throw new Error('Read-only mode: write operation denied');
    if (mode === 'auto' || !write) return;
    if (await approve(action, detail)) return;
    throw new Error(`Permission denied by the user: ${action}`);
  };

  const bash = (args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const p = spawn(args[0], args.slice(1), { cwd: opts.cwd ?? workspace, windowsHide: true });
      let out = '', err = '';
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* already dead */ } resolve({ code: null, out, err: err + '\n[timeout]' }); }, opts.timeoutMs ?? 15_000);
      p.stdout.on('data', d => out += d);
      p.stderr.on('data', d => err += d);
      p.on('error', reject);
      p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
    });

  const tools: Record<string, ToolDef> = {
    read_file: {
      description: 'Read a text file from the workspace. Returns content with line numbers. For long files use offset/limit.',
      parameters: {
        type: 'object', properties: {
          path: { type: 'string', description: 'Path relative to the workspace' },
          offset: { type: 'number', description: '1-indexed line to start from (optional)' },
          limit: { type: 'number', description: `Max lines to read (default ${limits.fileReadLimit})` },
        }, required: ['path'], additionalProperties: false,
      },
      run: async ({ path, offset = 1, limit = limits.fileReadLimit }) => {
        const full = await safePath(workspace, path);
        const raw = await readFile(full, 'utf8');
        const lines = raw.split('\n');
        const start = Math.max(1, offset) - 1;
        const slice = lines.slice(start, start + limit);
        const body = slice.map((l, i) => `${String(start + i + 1).padStart(5)} │ ${l}`).join('\n');
        const more = start + limit < lines.length ? `\n… (${lines.length - start - limit} more lines; raise offset)` : '';
        return trunc(body + more, limits.maxToolResultChars, 'file');
      },
    },
    list_files: {
      description: 'List files and folders of a workspace directory (non-recursive).',
      parameters: {
        type: 'object', properties: { path: { type: 'string', description: 'Relative directory (default ".")' } },
        additionalProperties: false,
      },
      run: async ({ path = '.' }) => {
        const full = await safePath(workspace, path);
        const entries = await readdir(full, { withFileTypes: true });
        if (!entries.length) return '(empty directory)';
        return entries.map(e => e.isDirectory() ? e.name + '/' : e.name).join('\n');
      },
    },
    glob: {
      description: 'Find files by glob pattern (e.g. "src/**/*.ts", "**/*.json"). Ignores node_modules and .git.',
      parameters: {
        type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern' } },
        required: ['pattern'], additionalProperties: false,
      },
      run: async ({ pattern }) => {
        const { code, out, err } = await bash(['bash', '-lc', `find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -print | grep -E "$(printf '%s' '${pattern.replace(/'/g, '')}' | sed 's|\\\\*\\\\*/|.*|g; s|\\\\*|[^/]*|g; s|\\\\.|\\\\\\\\.|g')"`]);
        if (code !== 0) return `glob error: ${err || 'no results'}`;
        return trunc(out || '(no matches)', limits.maxToolResultChars);
      },
    },
    search: {
      description: 'Search text/regex across workspace files (like ripgrep). Returns file:line: text.',
      parameters: {
        type: 'object', properties: {
          query: { type: 'string', description: 'Text or regex to search' },
          path: { type: 'string', description: 'Subdirectory (default ".")' },
          ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default false)' },
        }, required: ['query'], additionalProperties: false,
      },
      run: async ({ query, path = '.', ignoreCase = false }) => {
        const sub = await safePath(workspace, path);
        const rel = relative(workspace, sub) || '.';
        const flags = ignoreCase ? '-i' : '';
        let out = '';
        try {
          const r = await bash(['rg', '-n', flags, '--hidden', '-g', '!node_modules', '-g', '!.git', '-g', '!dist', query, rel].filter(Boolean));
          out = r.out + r.err;
        } catch {
          // fallback when ripgrep is missing
          const g = await bash(['grep', '-rn', ...flags.split(' ').filter(Boolean), '--exclude-dir=node_modules', '--exclude-dir=.git', query, rel]);
          out = g.out + g.err;
        }
        return trunc(out.trim() || '(no matches)', limits.maxToolResultChars);
      },
    },
    write_file: {
      description: 'Create or overwrite a file with the full content. For small changes prefer edit_file.',
      parameters: {
        type: 'object', properties: {
          path: { type: 'string', description: 'Path relative to the workspace' },
          content: { type: 'string', description: 'Full file content' },
        }, required: ['path', 'content'], additionalProperties: false,
      },
      run: async ({ path, content }) => {
        await guard('write_file', path, true);
        const full = await safePath(workspace, path);
        await mkdir(join(full, '..'), { recursive: true });
        let prev: string | null = null;
        try { prev = await readFile(full, 'utf8'); } catch { /* new file */ }
        await writeFile(full, content);
        if (prev !== null) await journal.record(async () => { await writeFile(full, prev!); return `Undone: ${path} restored`; });
        else await journal.record(async () => { await unlink(full); return `Undone: ${path} deleted`; });
        return `Wrote ${path} (${content.split('\n').length} lines)`;
      },
    },
    edit_file: {
      description: 'Edit a file by replacing an exact fragment. old_string must match literally and be unique; use allowMultiple only if you want every occurrence replaced.',
      parameters: {
        type: 'object', properties: {
          path: { type: 'string', description: 'Path relative to the workspace' },
          oldString: { type: 'string', description: 'Exact text to replace' },
          newString: { type: 'string', description: 'New text' },
          allowMultiple: { type: 'boolean', description: 'Replace all occurrences (default false)' },
        }, required: ['path', 'oldString', 'newString'], additionalProperties: false,
      },
      run: async ({ path, oldString, newString, allowMultiple = false }) => {
        await guard('edit_file', `${path} (${oldString.length} chars)`, true);
        const full = await safePath(workspace, path);
        const prev = await readFile(full, 'utf8');
        const count = prev.split(oldString).length - 1;
        if (count === 0) return 'ERROR: old_string not found in the file. Read the file and retry with the exact text.';
        if (count > 1 && !allowMultiple) return `ERROR: old_string appears ${count} times. Add more context or use allowMultiple: true.`;
        const next = allowMultiple ? prev.split(oldString).join(newString) : prev.replace(oldString, newString);
        await writeFile(full, next);
        await journal.record(async () => { await writeFile(full, prev); return `Undone: ${path} restored`; });
        return `Edited ${path}: ${count} replacement(s)`;
      },
    },
    delete_file: {
      description: 'Delete a file (recoverable with /undo).',
      parameters: {
        type: 'object', properties: { path: { type: 'string', description: 'Path relative to the workspace' } },
        required: ['path'], additionalProperties: false,
      },
      run: async ({ path }) => {
        await guard('delete_file', path, true);
        const full = await safePath(workspace, path);
        const prev = await readFile(full, 'utf8').catch(() => null);
        await unlink(full);
        if (prev !== null) await journal.record(async () => { await writeFile(full, prev); return `Undone: ${path} restored`; });
        else await journal.record(async () => `Undone: nothing to restore for ${path}`);
        return `Deleted ${path}`;
      },
    },
    move_path: {
      description: 'Move or rename a file or folder (recoverable with /undo).',
      parameters: {
        type: 'object', properties: {
          from: { type: 'string' }, to: { type: 'string' },
        }, required: ['from', 'to'], additionalProperties: false,
      },
      run: async ({ from, to }) => {
        await guard('move_path', `${from} → ${to}`, true);
        const src = await safePath(workspace, from);
        const dst = await safePath(workspace, to);
        await mkdir(join(dst, '..'), { recursive: true });
        await rename(src, dst);
        await journal.record(async () => { await rename(dst, src); return `Undone: ${to} moved back to ${from}`; });
        return `Moved ${from} → ${to}`;
      },
    },
    terminal_exec: {
      description: 'Run a shell command in the workspace. Use it for builds, tests, read-only git, dependency installs. Avoid destructive commands.',
      parameters: {
        type: 'object', properties: {
          command: { type: 'string', description: 'Command to run' },
          timeoutMs: { type: 'number', description: `Timeout in ms (default ${limits.toolTimeoutMs})` },
        }, required: ['command'], additionalProperties: false,
      },
      run: async ({ command, timeoutMs = limits.toolTimeoutMs }) => {
        const risky = dangerousReason(command);
        await guard('terminal_exec', command + (risky ? ` — ⚠ ${risky}` : ''), Boolean(risky) || true);
        const start = Date.now();
        const { code, out, err } = await bash(['bash', '-lc', command], { timeoutMs });
        const dur = ((Date.now() - start) / 1000).toFixed(1);
        const header = `[exit ${code ?? 'timeout'} · ${dur}s]`;
        const body = (out.trim() ? `-- stdout --\n${out.trim()}` : '') + (err.trim() ? `\n-- stderr --\n${err.trim()}` : '');
        return trunc(`${header}\n${body || '(no output)'}`, limits.maxToolResultChars, 'command output');
      },
    },
    git_status: {
      description: 'Show short git status (modified/new files).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const { out } = await bash(['git', 'status', '--short']);
        return out.trim() || '(clean workspace, not a git repo, or no changes)';
      },
    },
    task: {
      description: 'Delegate a self-contained subtask to an isolated subagent (no access to this conversation). The subagent investigates, uses tools and returns a final report. Use it for large explorations, broad searches or independent subtasks; NOT for trivial single-tool actions.',
      parameters: {
        type: 'object', properties: {
          task: { type: 'string', description: 'Complete self-contained instruction for the subagent (goal, context, relevant files and the expected report).' },
        }, required: ['task'], additionalProperties: false,
      },
      run: async ({ task }) => {
        if (!subagentCtx) return 'ERROR: the task tool is not available in this context.';
        if (signal?.aborted) return 'ERROR: task cancelled by the user.';
        const taskId = `subagent-${taskSeq.n++}`;
        const r = await runSubagent(task, {
          workspace,
          config: subagentCtx.config,
          approve,
          signal,
          projectInstructions: subagentCtx.projectInstructions,
          taskId,
          events: subagentCtx.events,
        });
        const head = r.aborted ? '[subagent CANCELLED by the user]\n' : '';
        const tail = `\n\n[subagent ${taskId}: ${r.toolCalls} tool calls · in=${r.usage.inputTokens ?? '?'} tok · out=${r.usage.outputTokens ?? '?'} tok]`;
        return head + r.report + tail;
      },
    },
    think: {
      description: 'Private reasoning space: plan before acting, weigh options or double-check your thinking. No side effects; echoes your own thought back.',
      parameters: {
        type: 'object', properties: {
          thought: { type: 'string', description: 'Your reasoning: plan, options, risks, next step.' },
        }, required: ['thought'], additionalProperties: false,
      },
      run: async ({ thought }) => `Thought recorded: ${thought}`,
    },
    todo_write: {
      description: 'Write your step list for the current task. Use it when starting multi-step tasks and update it as steps complete. Empty list marks the plan as finished.',
      parameters: {
        type: 'object', properties: {
          todos: {
            type: 'array', description: 'Ordered list of steps',
            items: {
              type: 'object', properties: {
                task: { type: 'string', description: 'Concrete step' },
                done: { type: 'boolean', description: 'true once completed' },
              }, required: ['task', 'done'], additionalProperties: false,
            },
          },
        }, required: ['todos'], additionalProperties: false,
      },
      run: async ({ todos }) => {
        if (!Array.isArray(todos)) return 'ERROR: todos must be an array.';
        let n = 0;
        const lines: string[] = [];
        for (const t of todos) {
          const task = typeof t?.task === 'string' ? t.task : String(t);
          const done = Boolean(t?.done);
          if (done) n++;
          lines.push(`  [${done ? 'x' : ' '}] ${task}`);
        }
        return `Task plan (${n}/${todos.length} completed):\n${lines.join('\n')}`;
      },
    },
  };

  const wrapped: Record<string, ToolDef> = {};
  for (const [name, def] of Object.entries(tools)) {
    wrapped[name] = {
      ...def,
      run: async (args: any) => {
        try {
          return await def.run(args);
        } catch (e: any) {
          return `ERROR: ${e?.message ?? String(e)}`;
        }
      },
    };
  }
  return wrapped;
}
