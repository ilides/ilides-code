#!/usr/bin/env node
// Minimal MCP stdio server fixture: initialize, tools/list, tools/call (echo).
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');

rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo-fixture', version: '1.0.0' } });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: [{
        name: 'echo',
        description: 'Echoes the given text',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }],
    });
  } else if (msg.method === 'tools/call') {
    reply(msg.id, { content: [{ type: 'text', text: 'echo: ' + (msg.params?.arguments?.text ?? '') }] });
  }
  // notifications (no id) are ignored on purpose
});
