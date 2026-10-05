import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDef } from './tools.js';

interface BgProc {
  p: ChildProcess;
  cmd: string;
  buf: string;
  code: number | null;
  startedAt: number;
}

const MAX_BUF = 200_000;        // chars kept per process
const MAX_LIFETIME_MS = 10 * 60_000; // auto-kill after 10 minutes

const procs = new Map<number, BgProc>();
let nextId = 1;

// Best-effort cleanup when the CLI exits.
process.on('exit', () => {
  for (const { p } of procs.values()) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
});

/**
 * background tool: start long-running shell commands, read their output and
 * kill them (the ILIDES equivalent of Claude Code's BashOutput/KillShell).
 */
export function backgroundTool(workspace: string, limits: { maxToolResultChars: number; toolTimeoutMs: number }): ToolDef {
  return {
    description: 'Run long-lived commands in the background (dev servers, watchers, builds). Actions: start returns an id; output reads a command\'s output; kill stops it; list shows running processes.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'output', 'kill', 'list'], description: 'What to do' },
        command: { type: 'string', description: 'Command to start (action=start)' },
        id: { type: 'number', description: 'Process id returned by start (action=output|kill)' },
        offset: { type: 'number', description: 'Char offset into the buffered output for pagination (action=output, default 0)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    run: async ({ action, command, id, offset = 0 }) => {
      if (action === 'list') {
        if (!procs.size) return '(no background processes)';
        return [...procs.entries()].map(([k, v]) => `#${k} pid=${v.p.pid} ${v.code === null ? 'running' : `exited ${v.code}`} — ${v.cmd.slice(0, 80)}`).join('\n');
      }
      if (action === 'start') {
        if (!command || typeof command !== 'string') return 'ERROR: command is required for action=start';
        const pid = nextId++;
        const p = spawn('bash', ['-lc', command], { cwd: workspace, windowsHide: true });
        const rec: BgProc = { p, cmd: command, buf: '', code: null, startedAt: Date.now() };
        p.stdout.on('data', d => { rec.buf += String(d); if (rec.buf.length > MAX_BUF) rec.buf = rec.buf.slice(-MAX_BUF); });
        p.stderr.on('data', d => { rec.buf += String(d); if (rec.buf.length > MAX_BUF) rec.buf = rec.buf.slice(-MAX_BUF); });
        p.on('close', code => { rec.code = code; });
        p.on('error', e => { rec.buf += `\n[spawn error: ${String(e)}]`; rec.code = -1; });
        setTimeout(() => { if (rec.code === null) { try { p.kill('SIGKILL'); } catch { /* gone */ } } }, MAX_LIFETIME_MS).unref?.();
        procs.set(pid, rec);
        return `Started background #${pid} (pid ${p.pid}): ${command}`;
      }
      if (action === 'output') {
        const rec = procs.get(id);
        if (!rec) return `ERROR: no background process with id ${id}`;
        const from = Math.max(0, Math.min(offset, rec.buf.length));
        const chunk = rec.buf.slice(from, limits.maxToolResultChars);
        const status = rec.code === null ? 'running' : `exited ${rec.code}`;
        const more = from + chunk.length < rec.buf.length ? `\n… more output available (offset ${from + chunk.length})` : '';
        const header = `[#${id} · ${status} · ${rec.buf.length} chars total]`;
        if (!chunk && rec.code === null) return `${header}\n(no new output yet)`;
        return `${header}\n${chunk}${more}`;
      }
      if (action === 'kill') {
        const rec = procs.get(id);
        if (!rec) return `ERROR: no background process with id ${id}`;
        if (rec.code === null) { try { rec.p.kill('SIGKILL'); } catch { /* gone */ } }
        procs.delete(id);
        return `Killed background #${id}`;
      }
      return `ERROR: unknown action "${action}" (use start|output|kill|list)`;
    },
  };
}
