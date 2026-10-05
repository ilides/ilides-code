import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeToolCall } from '../src/agent/agent.js';
import { makeTools, ChangeJournal } from '../src/tools/tools.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ok = async () => true;

test('executeToolCall runs the real tool (regression: never return a fake ERROR)', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'ilides-agent-'));
  try {
    const tools = makeTools(ws, 'auto', ok, new ChangeJournal());
    const call = { function: { name: 'write_file', arguments: JSON.stringify({ path: 'x.txt', content: 'real content' }) } };
    const res = await executeToolCall(call, tools, 12_000);
    assert.doesNotMatch(res, /^ERROR/);
    assert.equal(await readFile(join(ws, 'x.txt'), 'utf8'), 'real content');
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('executeToolCall handles unknown tools and invalid JSON', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'ilides-agent-'));
  try {
    const tools = makeTools(ws, 'auto', ok, new ChangeJournal());
    const bad1 = await executeToolCall({ function: { name: 'nope', arguments: '{}' } }, tools, 12_000);
    assert.match(bad1, /unknown tool/);
    const bad2 = await executeToolCall({ function: { name: 'list_files', arguments: '{bad json' } }, tools, 12_000);
    assert.match(bad2, /invalid JSON/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});
