import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

/**
 * Custom slash commands: markdown files in .ilides/commands/*.md (project)
 * and ~/.ilides/commands/*.md (global). Same idea as Claude Code custom commands.
 * Optional frontmatter: `description: ...`. `$ARGUMENTS` receives the typed args.
 */
export interface CustomCommand {
  name: string;
  description: string;
  body: string;
}

function parseCommand(name: string, raw: string): CustomCommand {
  let body = raw;
  let description = '';
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (d) description = d[1].trim().replace(/^["']|["']$/g, '');
    body = raw.slice(fm[0].length);
  }
  if (!description) description = (body.trim().split('\n')[0] ?? '').slice(0, 80);
  return { name, description, body: body.trim() };
}

async function loadFrom(dir: string, into: Map<string, CustomCommand>) {
  try {
    const files = (await readdir(dir)).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const name = basename(f, '.md').toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(name)) continue;
      const raw = await readFile(join(dir, f), 'utf8');
      into.set(name, parseCommand(name, raw));
    }
  } catch { /* no commands dir */ }
}

/** Global commands first, project commands override them. */
export async function loadCustomCommands(workspace: string): Promise<Map<string, CustomCommand>> {
  const out = new Map<string, CustomCommand>();
  await loadFrom(join(homedir(), '.ilides', 'commands'), out);
  await loadFrom(join(workspace, '.ilides', 'commands'), out);
  return out;
}

/** Expands $ARGUMENTS (or appends args when the placeholder is absent). */
export function expandCommand(cmd: CustomCommand, args: string): string {
  if (cmd.body.includes('$ARGUMENTS')) return cmd.body.split('$ARGUMENTS').join(args);
  return args ? `${cmd.body}\n\n${args}` : cmd.body;
}
