import { runAgentTurn, emptyState, type AgentState, type RunEvents, type LiveUsage } from './agent.js';
import { makeTools, ChangeJournal, type ToolDef } from '../tools/tools.js';
import type { Config } from '../config/config.js';

export interface SubagentResult {
  report: string;
  messages: number;
  toolCalls: number;
  usage: LiveUsage;
  aborted: boolean;
}

export interface SubagentEvents {
  onSubagentStart?: (taskId: string, prompt: string, model: string) => void;
  onSubagentTool?: (taskId: string, name: string, firstLine: string, ok: boolean) => void;
  onSubagentEnd?: (taskId: string, result: SubagentResult) => void;
}

export interface SubagentContext {
  workspace: string;
  config: Config;
  approve: (action: string, detail: string) => Promise<boolean>;
  signal?: AbortSignal;
  /** Project instructions (ILIDES.md), when present. */
  projectInstructions?: string | null;
  /** Task id used in progress events, e.g. "subagent-1". */
  taskId?: string;
  events?: SubagentEvents;
}

const SYSTEM = (workspace: string, task: string) =>
  [
    `You are a subagent of ILIDES Code. You work in isolation on a single concrete task and return a final report.`,
    `Workspace: ${workspace}`,
    `Delegated task: ${task}`,
    ``,
    `Rules:`,
    `- Work autonomously; nobody will answer questions while you run.`,
    `- Use the tools to investigate and act. Do not write questions to the user.`,
    `- Be efficient: the fewest steps needed to complete the task.`,
    `- Your last message is the ONLY result the main agent will receive: make it a self-contained report with conclusions, paths of the files touched, concrete data and any problems found. No greetings or meta-commentary.`,
    `- Answer in the language of the delegated task.`,
  ].join('\n');

/**
 * The subagent toolset: every tool except task (it cannot re-delegate)
 * and think (reasoning belongs to the main agent).
 */
export function subagentToolset(
  workspace: string,
  config: Config,
  approve: (action: string, detail: string) => Promise<boolean>,
  journal: ChangeJournal,
): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = makeTools(workspace, config.permissionMode, approve, journal, {
    fileReadLimit: config.fileReadLimit,
    maxToolResultChars: config.maxToolResultChars,
    toolTimeoutMs: config.toolTimeoutMs,
  });
  delete tools.task;
  delete tools.think;
  return tools;
}

/** Runs a task in an isolated subagent: own history, own journal, reduced toolset. */
export async function runSubagent(task: string, ctx: SubagentContext): Promise<SubagentResult> {
  const { workspace, config, approve, signal, taskId = 'subagent' } = ctx;

  const state: AgentState = emptyState(new ChangeJournal());
  const sub: SubagentEvents = {
    onSubagentStart: ctx.events?.onSubagentStart,
    onSubagentTool: ctx.events?.onSubagentTool,
    onSubagentEnd: ctx.events?.onSubagentEnd,
  };
  sub.onSubagentStart?.(taskId, task, config.model);

  const events: RunEvents = {
    signal,
    onToolEnd: (name, result) => {
      const first = result.split('\n')[0]?.slice(0, 120) ?? '';
      sub.onSubagentTool?.(taskId, name, first, !result.startsWith('ERROR'));
    },
  };

  const tools = subagentToolset(workspace, config, approve, state.journal);

  let report = '';
  let aborted = false;
  try {
    await runAgentTurn(
      task,
      workspace,
      { ...config, maxIterations: config.maxSubagentIterations },
      tools,
      state,
      events,
      ctx.projectInstructions ?? null,
      SYSTEM(workspace, task),
    );
    report = [...state.messages].reverse().find(m => m.role === 'assistant' && m.content)?.content ?? '';
  } catch (e: any) {
    if (e?.name === 'AbortError' || signal?.aborted) aborted = true;
    else report = `Subagent ERROR: ${e?.message ?? String(e)}`;
  }

  const toolCalls = state.messages.filter(m => m.role === 'tool').length;
  const result: SubagentResult = {
    report: report || (aborted ? '(subagent cancelled by the user)' : '(subagent returned no report)'),
    messages: state.messages.length,
    toolCalls,
    usage: state.usage,
    aborted,
  };
  sub.onSubagentEnd?.(taskId, result);
  return result;
}
