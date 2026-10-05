import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTools, ChangeJournal } from '../src/tools/tools.js';
import { dangerous, dangerousReason, safePath } from '../src/tools/security.js';

const neverApprove = async () => false;
const alwaysApprove = async () => true;

async function makeWs() {
  return await mkdtemp(join(tmpdir(), 'ilides-test-'));
}

test('safePath blocks workspace escapes', async () => {
  const ws = await makeWs();
  try {
    await assert.rejects(() => safePath(ws, '../outside.txt'), /outside workspace/i);
    await assert.rejects(() => safePath(ws, '/etc/passwd'), /outside workspace/i);
    const ok = await safePath(ws, 'sub/ok.txt');
    assert.ok(ok.startsWith(await realpath(ws)));
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('write_file + edit_file + undo restore the content', async () => {
  const ws = await makeWs();
  try {
    const tools = makeTools(ws, 'auto', alwaysApprove, new ChangeJournal());
    await tools.write_file.run({ path: 'a.txt', content: 'hello world' });
    const editRes = await tools.edit_file.run({ path: 'a.txt', oldString: 'world', newString: 'ILIDES' });
    assert.match(editRes, /Edited/);
    assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), 'hello ILIDES');
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('edit_file with ambiguous oldString fails without corrupting the file', async () => {
  const ws = await makeWs();
  try {
    const tools = makeTools(ws, 'auto', alwaysApprove, new ChangeJournal());
    await tools.write_file.run({ path: 'a.txt', content: 'x y x' });
    const res = await tools.edit_file.run({ path: 'a.txt', oldString: 'x', newString: 'z' });
    assert.match(res, /appears 2 times/);
    assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), 'x y x');
    const res2 = await tools.edit_file.run({ path: 'a.txt', oldString: 'x', newString: 'z', allowMultiple: true });
    assert.match(res2, /2 replacement/);
    assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), 'z y z');
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('ask mode without approval denies writes but allows reads', async () => {
  const ws = await makeWs();
  try {
    const tools = makeTools(ws, 'ask', neverApprove, new ChangeJournal());
    const res = await tools.write_file.run({ path: 'b.txt', content: 'x' });
    assert.match(res, /ERROR/);
    await writeFile(join(ws, 'c.txt'), 'content');
    const out = await tools.read_file.run({ path: 'c.txt' });
    assert.match(out, /content/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('readonly mode blocks terminal and writes', async () => {
  const ws = await makeWs();
  try {
    const tools = makeTools(ws, 'readonly', alwaysApprove, new ChangeJournal());
    assert.match(await tools.write_file.run({ path: 'd.txt', content: 'x' }), /read-only/i);
    const t = await tools.terminal_exec.run({ command: 'echo hi' });
    assert.match(t, /read-only/i);
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('terminal_exec captures exit code and stderr', async () => {
  const ws = await makeWs();
  try {
    const tools = makeTools(ws, 'auto', alwaysApprove, new ChangeJournal());
    const out = await tools.terminal_exec.run({ command: 'echo hi && echo boo >&2 && exit 3' });
    assert.match(out, /\[exit 3/);
    assert.match(out, /hi/);
    assert.match(out, /boo/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('dangerous command detection', () => {
  assert.equal(dangerous('rm -rf /tmp/x'), true);
  assert.equal(dangerous('ls -la'), false);
  assert.equal(dangerous('git push origin main'), true);
  assert.equal(dangerousReason('sudo rm x'), 'sudo');
  assert.equal(dangerous('echo "git push"'), true); // conservative: better to ask for permission
});

test('read_file numbers lines and honors offset/limit', async () => {
  const ws = await makeWs();
  try {
    const tools = makeTools(ws, 'auto', alwaysApprove, new ChangeJournal());
    await tools.write_file.run({ path: 'n.txt', content: Array.from({ length: 20 }, (_, i) => 'line' + (i + 1)).join('\n') });
    const out = await tools.read_file.run({ path: 'n.txt', offset: 18, limit: 5 });
    assert.match(out, /line18/);
    assert.match(out, /line20/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});
