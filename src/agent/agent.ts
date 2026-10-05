import { client } from '../providers/openrouter/client.js';
import type { Config } from '../config/config.js';
import type { ToolDef, ChangeJournal } from '../tools/tools.js';
import type { SubagentEvents } from './subagents.js';

export interface LiveUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
}

export interface RunEvents {
  onDelta?: (text: string) => void;              // assistant text in streaming
  onToolStart?: (name: string, args: string) => void;
  onToolEnd?: (name: string, result: string) => void;
  onUsage?: (u: LiveUsage) => void;
  subagentEvents?: SubagentEvents;
  signal?: AbortSignal;
}

export interface AgentState {
  messages: any[];
  usage: LiveUsage;
  journal: ChangeJournal;
}

export type { ToolDef };

function systemPrompt(workspace: string, project?: string | null) {
  return [
    `You are ILIDES Code, a coding agent that works in the terminal.`,
    `Workspace: ${workspace}`,
    `Rules:`,
    `- Inspect before modifying: use read_file/list_files/search/glob to understand the code.`,
    `- On multi-step tasks, write a plan with todo_write and keep it updated as you go.`,
    `- For large independent subtasks (exploring lots of code, weighing alternatives), delegate with task to an isolated subagent; do not use it for trivial actions.`,
    `- For non-trivial decisions, reason with think first (plan, risks, next step).`,
    `- Make the smallest change that solves the task and follow the project's style.`,
    `- Prefer edit_file for surgical changes; write_file only for new files or full rewrites.`,
    `- Verify your changes (build/tests) with terminal_exec when relevant.`,
    `- Never claim you did something you did not. If something fails, report it clearly.`,
    `- Answer in the user's language.`,
    project ? `\n# Project instructions (ILIDES.md)\n${project}` : '',
  ].filter(Boolean).join('\n');
}

/** Runs a tool call and always returns a string for the history. */
export async function executeToolCall(call: any, tools: Record<string, ToolDef>, maxChars: number): Promise<string> {
  const tool = tools[call.function.name];
  if (!tool) return `ERROR: unknown tool "${call.function.name}". Use one of the available tools.`;
  let args: any;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return 'ERROR: invalid JSON arguments. Retry the call with valid JSON.';
  }
  try {
    const out = String(await tool.run(args));
    return out.slice(0, maxChars);
  } catch (e: any) {
    return `ERROR: ${e?.message ?? String(e)}`;
  }
}

/** Runs one turn: the conversation (state.messages) persists across calls. */
export async function runAgentTurn(
  userMessage: string,
  workspace: string,
  config: Config,
  tools: Record<string, ToolDef>,
  state: AgentState,
  events: RunEvents = {},
  projectInstructions: string | null = null,
  customSystem: string | null = null,
): Promise<AgentState> {
  const ai = client(config);
  const defs = Object.entries(tools).map(([name, t]) => ({
    type: 'function' as const,
    function: { name, description: t.description, parameters: t.parameters },
  }));

  if (state.messages.length === 0) {
    const system = customSystem
      ? [customSystem, projectInstructions ? `\n# Project instructions (ILIDES.md)\n${projectInstructions}` : ''].filter(Boolean).join('\n')
      : systemPrompt(workspace, projectInstructions);
    state.messages.push({ role: 'system', content: system });
  }
  state.messages.push({ role: 'user', content: userMessage });

  // History trimming: always keeps the system message and this turn's messages.
  const trimHistory = () => {
    const m = state.messages;
    const keepSystem = m[0]?.role === 'system' ? 1 : 0;
    const over = m.length - keepSystem - config.maxHistoryTurns;
    if (over > 0) m.splice(keepSystem, over);
  };
  trimHistory();

  for (let i = 0; i < config.maxIterations; i++) {
    const stream = await ai.chat.completions.create({
      model: config.model,
      messages: state.messages,
      temperature: config.temperature,
      tools: defs as any,
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    } as any, { signal: events.signal });

    let content = '';
    const calls: any[] = [];
    let usage: any;

    try {
      for await (const chunk of stream as any) {
        if (events.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (chunk.usage) usage = chunk.usage;
        const d = chunk.choices?.[0]?.delta;
        if (d?.content) { content += d.content; events.onDelta?.(d.content); }
        for (const c of d?.tool_calls ?? []) {
          const x = calls[c.index] ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          x.id += c.id ?? '';
          x.function.name += c.function?.name ?? '';
          x.function.arguments += c.function?.arguments ?? '';
          calls[c.index] = x;
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError' || events.signal?.aborted) {
        if (content) state.messages.push({ role: 'assistant', content });
        throw e;
      }
      throw e;
    }

    if (usage) {
      const u: LiveUsage = {
        inputTokens: usage.prompt_tokens ?? null,
        outputTokens: usage.completion_tokens ?? null,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
      };
      state.usage = {
        inputTokens: (state.usage.inputTokens ?? 0) + (u.inputTokens ?? 0),
        outputTokens: (state.usage.outputTokens ?? 0) + (u.outputTokens ?? 0),
        reasoningTokens: (state.usage.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0),
        cachedTokens: (state.usage.cachedTokens ?? 0) + (u.cachedTokens ?? 0),
      };
      events.onUsage?.(state.usage);
    }

    const message: any = { role: 'assistant', content: content || null };
    if (calls.length) message.tool_calls = calls;
    state.messages.push(message);

    if (!calls.length) return state;

    for (const call of calls) {
      events.onToolStart?.(call.function.name, call.function.arguments);
      const result = await executeToolCall(call, tools, config.maxToolResultChars);
      events.onToolEnd?.(call.function.name, result);
      state.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  throw new Error(`Maximum iterations reached (${config.maxIterations}). Continue with more context or raise maxIterations.`);
}

export function emptyState(journal: ChangeJournal): AgentState {
  return { messages: [], usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null }, journal };
}
