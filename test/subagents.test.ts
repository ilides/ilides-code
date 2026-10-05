import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subagentToolset } from '../src/agent/subagents.js';
import { makeTools, ChangeJournal } from '../src/tools/tools.js';
import type { Config } from '../src/config/config.js';
import { defaults } from '../src/config/config.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ok = async () => true;

test('todo_write formats the plan with counters', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'ilides-todo-'));
  try {
    const tools = makeTools(ws, 'auto', ok, new ChangeJournal());
    const res = await tools.todo_write.run({
      todos: [
        { task: 'explore the code', done: true },
        { task: 'write tests', done: false },
      ],
    });
    assert.match(res, /1\/2 completed/);
    assert.match(res, /\[x\] explore the code/);
    assert.match(res, /\[ \] write tests/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('think returns the recorded thought', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'ilides-think-'));
  try {
    const tools = makeTools(ws, 'auto', ok, new ChangeJournal());
    const res = await tools.think.run({ thought: 'I should edit file A before file B' });
    assert.match(res, /Thought recorded/);
    assert.match(res, /file A/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('task without subagent context returns a controlled error', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'ilides-task-'));
  try {
    const tools = makeTools(ws, 'auto', ok, new ChangeJournal());
    const res = await tools.task.run({ task: 'anything' });
    assert.match(res, /ERROR/);
    assert.match(res, /not available/);
  } finally { await rm(ws, { recursive: true, force: true }); }
});

test('subagentToolset excludes task and think', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'ilides-subts-'));
  try {
    const cfg: Config = { ...defaults };
    const tools = subagentToolset(ws, cfg, ok, new ChangeJournal());
    assert.equal(tools.task, undefined, 'subagents must not re-delegate');
    assert.equal(tools.think, undefined, 'think belongs to the main agent');
    assert.ok(tools.read_file, 'keeps read tools');
    assert.ok(tools.terminal_exec, 'keeps terminal tools');
  } finally { await rm(ws, { recursive: true, force: true }); }
});
