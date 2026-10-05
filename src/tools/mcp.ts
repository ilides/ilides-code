import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolDef } from './tools.js';

/**
 * Minimal MCP (Model Context Protocol) client for stdio servers.
 * Reads `<workspace>/.ilides/mcp.json` and `~/.ilides/mcp.json` (Claude Code
 * format: { "mcpServers": { "name": { "command": "...", "args": [], "env": {} } } }),
 * performs the initialize handshake and exposes every server tool as
 * `mcp_<server>_<tool>`.
 */

const PROTOCOL_VERSION = '2024-11-05';
const INIT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

interface McpServer {
  name: string;
  proc: ChildProcess;
  buf: string;
  nextId: number;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  dead: boolean;
}

const servers: McpServer[] = [];
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const s of servers) { try { s.proc.kill('SIGKILL'); } catch { /* gone */ } }
  });
}

function request(s: McpServer, method: string, params: any, timeoutMs: number): Promise<any> {
  if (s.dead) return Promise.reject(new Error(`MCP server "${s.name}" is not running`));
  const id = ++s.nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error(`MCP "${s.name}" ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    s.pending.set(id, { resolve, reject, timer });
    try {
      s.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (e) {
      s.pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`MCP "${s.name}" write failed: ${String(e)}`));
    }
  });
}

function notify(s: McpServer, method: string, params: any) {
  if (s.dead) return;
  try { s.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* ignore */ }
}

function startServer(name: string, command: string, args: string[], env: Record<string, string>): McpServer {
  const proc = spawn(command, args, { windowsHide: true, env: { ...process.env, ...env } });
  const s: McpServer = { name, proc, buf: '', nextId: 0, pending: new Map(), dead: false };

  proc.stdout!.on('data', d => {
    s.buf += String(d);
    let nl: number;
    while ((nl = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, nl).trim();
      s.buf = s.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; } // ignore non-JSON chatter
      if (msg.id !== undefined && s.pending.has(msg.id)) {
        const p = s.pending.get(msg.id)!;
        s.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`MCP "${name}" error ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
    }
  });
  proc.stderr!.on('data', () => { /* servers log to stderr; ignore */ });
  const markDead = () => {
    s.dead = true;
    for (const [, p] of s.pending) { clearTimeout(p.timer); p.reject(new Error(`MCP server "${name}" exited`)); }
    s.pending.clear();
  };
  proc.on('close', markDead);
  proc.on('error', markDead);
  return s;
}

async function readMcpConfig(workspace: string): Promise<Record<string, { command: string; args?: string[]; env?: Record<string, string> }>> {
  const out: Record<string, any> = {};
  for (const path of [join(homedir(), '.ilides', 'mcp.json'), join(workspace, '.ilides', 'mcp.json')]) {
    try {
      const j = JSON.parse(await readFile(path, 'utf8'));
      const servers_ = j?.mcpServers ?? {};
      for (const [name, def] of Object.entries(servers_)) {
        const d = def as any;
        if (typeof d?.command === 'string') out[name] = d;
      }
    } catch { /* no config */ }
  }
  return out;
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Starts every configured MCP server and returns its tools.
 * Returns {} when no config exists or all servers fail (never throws).
 */
export async function loadMcpTools(workspace: string, maxToolResultChars = 12_000): Promise<Record<string, ToolDef>> {
  const defs = await readMcpConfig(workspace);
  const tools: Record<string, ToolDef> = {};
  installExitHook();

  for (const [name, def] of Object.entries(defs)) {
    try {
      const s = startServer(name, def.command, def.args ?? [], def.env ?? {});
      servers.push(s);
      await request(s, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ilides-code', version: '0.4.0' },
      }, INIT_TIMEOUT_MS);
      notify(s, 'notifications/initialized', {});
      const list: any = await request(s, 'tools/list', {}, INIT_TIMEOUT_MS);
      for (const t of list?.tools ?? []) {
        if (typeof t?.name !== 'string') continue;
        let toolName = `mcp_${sanitize(name)}_${sanitize(t.name)}`;
        while (tools[toolName]) toolName += '_';
        const serverName = name;
        const mcpToolName = t.name;
        tools[toolName] = {
          description: `${t.description ?? t.name} [MCP server: ${serverName}]`,
          parameters: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : { type: 'object', properties: {} },
          run: async (args: any) => {
            const r: any = await request(s, 'tools/call', { name: mcpToolName, arguments: args ?? {} }, CALL_TIMEOUT_MS);
            const parts: string[] = [];
            for (const c of r?.content ?? []) {
              if (c?.type === 'text') parts.push(String(c.text ?? ''));
              else if (c?.type === 'image') parts.push('[image content]');
              else if (c?.type === 'resource') parts.push('[resource content]');
            }
            const out = parts.join('\n') || '(no content)';
            const capped = out.slice(0, maxToolResultChars);
            if (r?.isError) return `ERROR: ${capped}`;
            return capped;
          },
        };
      }
    } catch (e) {
      // Leave the failed server out; the rest still work.
      continue;
    }
  }
  return tools;
}

/** Kills all MCP servers (called on shutdown). */
export async function shutdownMcp(): Promise<void> {
  for (const s of servers) {
    try { s.proc.kill('SIGTERM'); } catch { /* gone */ }
  }
  servers.length = 0;
}
