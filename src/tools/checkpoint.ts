import { mkdir, readdir, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { SKIP_DIRS } from './repoMap.js';

/** Checkpoints: workspace snapshots taken before each task (rewind, unlike /undo). */

const MAX_CHECKPOINTS = 10;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const ckDir = (workspace: string) => join(workspace, '.ilides', 'checkpoints');

async function walkFiles(workspace: string, base = workspace, out: string[] = []): Promise<string[]> {
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && relative(workspace, join(base, e.name)) !== '.ilides') {
      if (SKIP_DIRS.has(e.name) || e.name === '.DS_Store') continue;
      if (e.name.startsWith('.') && join(base, e.name) !== join(workspace, '.ilides')) continue;
    }
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(base, e.name);
    if (e.isDirectory()) await walkFiles(workspace, full, out);
    else if (e.isFile()) {
      try { if ((await stat(full)).size <= MAX_FILE_BYTES) out.push(full); } catch { /* skip */ }
    }
  }
  return out;
}

/** Copies the workspace (minus junk) into .ilides/checkpoints/<id>. Keeps the last 10. */
export async function snapshot(workspace: string): Promise<string | null> {
  try {
    const files = (await walkFiles(workspace)).filter(f => !f.includes('/.ilides/'));
    if (!files.length) return null;
    const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = ckDir(workspace);
    await mkdir(dest, { recursive: true });
    const manifest: string[] = [];
    for (const f of files) {
      const rel = relative(workspace, f);
      const target = join(dest, id, rel);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(f, target);
      manifest.push(rel);
    }
    await writeFile(join(dest, id, '.manifest.json'), JSON.stringify(manifest));
    await prune(workspace);
    return id;
  } catch {
    return null;
  }
}

async function prune(workspace: string) {
  try {
    const all = (await readdir(ckDir(workspace), { withFileTypes: true }))
      .filter(e => e.isDirectory()).map(e => e.name).sort();
    while (all.length > MAX_CHECKPOINTS) {
      const old = all.shift()!;
      await rm(join(ckDir(workspace), old), { recursive: true, force: true });
    }
  } catch { /* nothing to prune */ }
}

export async function listCheckpoints(workspace: string): Promise<Array<{ id: string; files: number }>> {
  try {
    const dirs = (await readdir(ckDir(workspace), { withFileTypes: true }))
      .filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
    const out = [];
    for (const id of dirs) {
      try {
        const m = JSON.parse(await readFile(join(ckDir(workspace), id, '.manifest.json'), 'utf8'));
        out.push({ id, files: m.length });
      } catch { /* skip corrupt */ }
    }
    return out;
  } catch { return []; }
}

export interface RewindResult {
  restored: string[];
  extras: string[];   // files created after the checkpoint (candidates for deletion)
}

/** Restores every file of a checkpoint. Returns files that did not exist then. */
export async function rewind(workspace: string, id: string): Promise<RewindResult> {
  const manifestPath = join(ckDir(workspace), id, '.manifest.json');
  const manifest: string[] = JSON.parse(await readFile(manifestPath, 'utf8'));
  const restored: string[] = [];
  for (const rel of manifest) {
    const src = join(ckDir(workspace), id, rel);
    const dst = join(workspace, rel);
    try {
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      restored.push(rel);
    } catch { /* file may be missing in snapshot copy */ }
  }
  const current = (await walkFiles(workspace)).map(f => relative(workspace, f)).filter(f => !f.includes('/.ilides/'));
  const extras = current.filter(f => !manifest.includes(f));
  return { restored, extras };
}

export async function deleteCheckpoint(workspace: string, id: string) {
  await rm(join(ckDir(workspace), id), { recursive: true, force: true });
}
