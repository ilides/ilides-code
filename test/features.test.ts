import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHooks, runHooks } from '../src/tools/hooks.js';
import { loadCustomCommands, expandCommand } from '../src/cli/commands.js';
import { backgroundTool } from '../src/tools/background.js';
import { snapshot, rewind } from '../src/tools/checkpoint.js';
import { buildRepoMap } from '../src/tools/repoMap.js';
import { htmlToText } from '../src/tools/web.js';
import { makeTools, ChangeJournal } from '../src/tools/tools.js';
import { IMAGE_PREFIX, parseImageResult } from '../src/tools/image.js';
import { loadMcpTools, shutdownMcp } from '../src/tools/mcp.js';

const ok = async () => true;
const makeWs = () => mkdtemp(join(tmpdir(), 'ilides-feat-'));

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('hooks: PreToolUse blocks on failure, PostToolUse runs side effects', async () => {
  const ws = await makeWs();
  try {
    await mkdir(join(ws, '.ilides'), { recursive: true });
    const marker = join(ws, 'hooked.txt');
    await writeFile(join(ws, '.ilides', 'hooks.json'), JSON.stringify({
      PreToolUse: ['exit 1'],
      PostToolUse: [`printf formatted > "${marker}"`],
    }));
    const hooks = await loadHooks(ws);

    const pre = await runHooks('PreToolUse', hooks, { workspace: ws, tool: 'write_file', input: { path: 'a' } });
    assert.equal(pre.blocked, true, 'non-zero exit must block');
    assert.ok(pre.reason, 'blocking reason is reported');

    const post = await runHooks('PostToolUse', hooks, { workspace: ws, tool: 'write_file', input: {}, output: 'x' });
    assert.equal(post.blocked, false, 'PostToolUse never blocks');
    assert.match(await readFile(marker, 'utf8'), /formatted/);

    const failing = await runHooks('PostToolUse', { PostToolUse: ['exit 3'] }, { workspace: ws, tool: 't' });
    assert.equal(failing.blocked, false);
    assert.equal(failing.notes.length, 1, 'failing PostToolUse is reported as a note');
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('custom commands: load from .ilides/commands and expand $ARGUMENTS', async () => {
  const ws = await makeWs();
  try {
    await mkdir(join(ws, '.ilides', 'commands'), { recursive: true });
    await writeFile(join(ws, '.ilides', 'commands', 'review.md'),
      '---\ndescription: Review code quality\n---\nReview this code for bugs:\n$ARGUMENTS\n');
    const cmds = await loadCustomCommands(ws);
    assert.ok(cmds.has('review'), 'command discovered');
    assert.equal(cmds.get('review')!.description, 'Review code quality');
    const expanded = expandCommand(cmds.get('review')!, 'src/main.ts');
    assert.match(expanded, /src\/main\.ts/);
    assert.match(expanded, /Review this code/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('background: start, read output and kill', async () => {
  const ws = await makeWs();
  try {
    const t = backgroundTool(ws, { maxToolResultChars: 12_000, toolTimeoutMs: 120_000 });
    const start = await t.run({ action: 'start', command: 'echo hello-bg; sleep 30' });
    assert.match(start, /Started background #(\d+)/);
    const id = Number(/#(\d+)/.exec(start)![1]);
    await new Promise(r => setTimeout(r, 400));
    const out = await t.run({ action: 'output', id });
    assert.match(out, /hello-bg/);
    assert.match(out, /running/);
    const killed = await t.run({ action: 'kill', id });
    assert.match(killed, /Killed/);
    const list = await t.run({ action: 'list' });
    assert.doesNotMatch(list, /hello-bg/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('checkpoints: snapshot + rewind restores content and lists extras', async () => {
  const ws = await makeWs();
  try {
    await writeFile(join(ws, 'a.txt'), 'original');
    const id = await snapshot(ws);
    assert.ok(id, 'checkpoint created');
    await writeFile(join(ws, 'a.txt'), 'changed');
    await writeFile(join(ws, 'new.txt'), 'created later');
    const r = await rewind(ws, id!);
    assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), 'original', 'file restored');
    assert.ok(r.extras.includes('new.txt'), 'extra file reported');
    assert.ok(r.restored.includes('a.txt'));
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('repo map: builds a tree excluding node_modules and dotfiles', async () => {
  const ws = await makeWs();
  try {
    await mkdir(join(ws, 'src'), { recursive: true });
    await mkdir(join(ws, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(ws, 'src', 'main.ts'), 'export {};');
    await writeFile(join(ws, 'secret.txt'), 'x');
    const map = await buildRepoMap(ws);
    assert.ok(map, 'map produced');
    assert.match(map!, /src\//);
    assert.match(map!, /main\.ts/);
    assert.doesNotMatch(map!, /node_modules/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('web: htmlToText strips scripts and tags', () => {
  const text = htmlToText('<html><style>b{}</style><p>Hello <b>world</b></p><script>secretCall()</script></html>');
  assert.match(text, /Hello world/);
  assert.doesNotMatch(text, /secretCall/);
  assert.doesNotMatch(text, /<p>/);
});

test('view_image: returns an untruncated marker parseable as an image', async () => {
  const ws = await makeWs();
  try {
    await writeFile(join(ws, 'img.png'), Buffer.from(PNG_1PX, 'base64'));
    const tools = makeTools(ws, 'auto', ok, new ChangeJournal());
    const res = await tools.view_image.run({ path: 'img.png' });
    assert.ok(res.startsWith(IMAGE_PREFIX), 'image marker present');
    const parsed = parseImageResult(res);
    assert.equal(parsed?.mime, 'image/png');
    assert.equal(parsed?.b64, PNG_1PX);
    const bad = await tools.view_image.run({ path: 'missing' }).catch(e => `ERROR: ${e.message}`);
    assert.match(String(bad), /ERROR/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('MCP: connects to a stdio server, lists and calls its tools', async () => {
  const ws = await makeWs();
  try {
    await mkdir(join(ws, '.ilides'), { recursive: true });
    const fixture = join(process.cwd(), 'test', 'fixtures', 'mcp-server.mjs');
    await writeFile(join(ws, '.ilides', 'mcp.json'), JSON.stringify({
      mcpServers: { echo: { command: process.execPath, args: [fixture] } },
    }));
    const tools = await loadMcpTools(ws);
    assert.ok(tools.mcp_echo_echo, `tool registered (got: ${Object.keys(tools).join(', ') || 'none'})`);
    const out = await tools.mcp_echo_echo.run({ text: 'hola' });
    assert.match(out, /echo: hola/);
  } finally {
    await shutdownMcp();
    await rm(ws, { recursive: true, force: true });
  }
});
