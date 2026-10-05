# ILIDES Code

Coding agent for the terminal (TypeScript + OpenRouter) with **subagents**, **plan mode**, **MCP**, **hooks**, **custom commands**, persistent sessions, undo and cost tracking.

## Quick start

Set your OpenRouter API key once, inside the CLI:

```
❯ /api sk-or-...        # saved to ~/.ilides/auth.json (permissions 600)
```

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys). The `OPENROUTER_API_KEY` environment variable also works and takes precedence.

## Installation (without `npm run dev`)

```bash
npm run build && npm pack
npm install -g ilides-code-*.tgz      # option A
npm link                               # option B: link this checkout
node dist/ilides.mjs                   # option C: single self-contained file
```

Only Node 18+ and an API key are required.

## Non-interactive mode

```bash
ilides -p "explain what src/agent/agent.ts does"     # runs one task and exits
ilides -p "fix the failing test" -y                  # auto-approve writes and commands
ilides -p "analyze the project" --readonly           # read-only
ilides -p "..." -m anthropic/claude-sonnet-4         # specific model
```

## Plan mode

`/plan` toggles a read-only exploration mode (Claude Code-style):

- Only read-only tools are available (no writes, no shell, no MCP).
- When exploration is done the agent calls `exit_plan_mode` with a full plan.
- You approve it (the agent starts implementing) or reject it (exploration continues).

`/diff` shows pending changes (`git diff`) before you commit, and `/commit` generates a conventional commit message with the model, shows it and asks for confirmation.

## Subagents

The main agent can delegate subtasks with the **`task`** tool: each subagent has its own conversation and `/undo`, the same model and permissions, cannot re-delegate, and returns a single final report. See `/agents`.

## Hooks

User shell commands that run on agent lifecycle events, configured in `.ilides/hooks.json` (project) and `~/.ilides/hooks.json` (global):

```json
{
  "PreToolUse":  ["case \"$ILIDES_TOOL_NAME\" in write_file|edit_file) … ;; esac"],
  "PostToolUse": ["npx prettier --write \"$ILIDES_TOOL_INPUT\" >/dev/null 2>&1 || true"],
  "Stop":        ["say 'agent finished' || true"]
}
```

- **PreToolUse** runs before each tool call; a non-zero exit **blocks** the tool (the model sees the stderr as the error).
- **PostToolUse** runs after each tool call (auto-format, lint).
- **Stop** runs when the agent finishes a turn.

Available env vars: `ILIDES_WORKSPACE`, `ILIDES_TOOL_NAME`, `ILIDES_TOOL_INPUT` (JSON), `ILIDES_TOOL_OUTPUT`.

## Custom commands

Markdown files become slash commands (Claude Code-style):

- `~/.ilides/commands/*.md` (global) and `.ilides/commands/*.md` (project, overrides global).
- Optional frontmatter `description:`; `$ARGUMENTS` receives everything typed after the command.

```
.review src/main.ts      →  runs your /review prompt with the args
```

They show up in `/help` and in tab completion.

## MCP (Model Context Protocol)

Connect external tool servers in `.ilides/mcp.json` (Claude Code format):

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }
  }
}
```

Every server tool is exposed as `mcp_<server>_<tool>` to the agent (stdio transport, JSON-RPC).

## Web, images and background processes

- `web_search` — current information with source URLs (OpenRouter `:online`, no extra key).
- `web_fetch` — fetch a URL and read its text (docs, error pages).
- `view_image` — send screenshots/diagrams/designs to the vision-capable model.
- `background` — start long-lived commands (dev servers, watchers), read their output (`output`), stop them (`kill`).

## Checkpoints and rewind

Before every task the workspace is snapshotted to `.ilides/checkpoints/<id>/` (excluding `node_modules`, `.git`, `dist`…):

- `/checkpoints` — list snapshots.
- `/rewind [id]` — restore all files to a point in time and optionally delete files created since (stronger than `/undo`, which only reverts the last change).

Disable with `/set checkpoints false`.

## Context and budget

- The title and footer show **context usage** (`ctx %`) and **estimated cost** per turn.
- `autoCompact` (default on): the history is summarized automatically above 85% of the model window.
- `budget` (USD): when the session cost reaches it, the current task is aborted and new ones refuse to start. Clear usage with `/cost reset`, raise with `/set budget <usd>`.

## The `/api` command

```
/api                show key status (masked)
/api sk-or-...      save the key to ~/.ilides/auth.json (chmod 600)
/api remove         delete the stored key
```

## The `/set` command

`temperature`, `maxIterations`, `maxHistoryTurns`, `maxSubagentIterations`, `fileReadLimit`, `toolTimeoutMs`, `maxToolResultChars`, `budget`, `autoCompact`, `checkpoints`, `permissionMode`.

## Agent tools

| Tool | Description |
|---|---|
| `read_file` | line numbers, `offset/limit` for large files |
| `write_file` / `edit_file` | full write / surgical replace with ambiguity detection |
| `glob` / `search` / `list_files` | discover files and search text (`grep` fallback) |
| `terminal_exec` | shell commands with exit code, duration and stderr separated |
| `git_status` | short git status |
| `move_path` / `delete_file` | move/rename/delete (recoverable with `/undo`) |
| `task` | delegate to an isolated subagent |
| `todo_write` / `think` | step plan / private reasoning |
| `web_search` / `web_fetch` | search the web / read a URL |
| `view_image` | attach an image to the conversation |
| `background` | start/output/kill background processes |
| `exit_plan_mode` | present a plan for approval (plan mode only) |
| `mcp_<server>_<tool>` | tools from connected MCP servers |

## Interactive session

```
/help /api /plan /diff /commit /checkpoints /rewind
/new /resume /model /set /permissions /undo /compact
/cost [reset] /config /status /agents /clear /exit
```

- `Ctrl+C` cancels the current task and keeps context; twice exits.
- Multi-line input with a trailing `\`.
- The agent reads `ILIDES.md` and a repository map (file tree) on startup.

## Permissions

`readonly` · `ask` (default, asks before writes and risky commands) · `auto` (approves everything).

## Development

```bash
npm run dev     # run src/ directly with tsx
npm test        # 22 tests (node:test)
npm run build   # tsc + standalone bundle in dist/
```

Layout: `src/cli` (REPL, custom commands, non-interactive mode), `src/agent` (agent loop, subagents, hooks, one-shot completions), `src/tools` (tools, security, MCP, web, checkpoints, background), `src/config`, `src/providers/openrouter`.

## Contributing

Issues and pull requests are welcome. Run `npm test` and `npm run build` before sending changes.

## License

[MIT](LICENSE)
