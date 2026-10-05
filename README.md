# ILIDES Code

Coding agent for the terminal (TypeScript + OpenRouter) with **subagents**, persistent sessions, undo for file changes and cost tracking.

## Quick start

Set your OpenRouter API key once, inside the CLI:

```
❯ /api sk-or-...        # saved to ~/.ilides/auth.json (permissions 600)
```

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys). The `OPENROUTER_API_KEY` environment variable also works and takes precedence.

## Installation (without `npm run dev`)

### Option A — install the package globally

```bash
npm run build && npm pack
npm install -g ilides-code-*.tgz
ilides --help
```

### Option B — link this checkout globally (development)

```bash
npm install && npm run build && npm link
ilides
```

### Option C — single file, nothing installed

`dist/ilides.mjs` is a self-contained bundle (includes the `openai` dependency):

```bash
node dist/ilides.mjs            # interactive session
node dist/ilides.mjs --help     # help
```

Only Node 18+ and an API key are required.

## Non-interactive mode

```bash
ilides -p "explain what src/agent/agent.ts does"     # runs one task and exits
ilides -p "fix the failing test" -y                  # auto-approve writes and commands
ilides -p "analyze the project" --readonly           # read-only
ilides -p "..." -m anthropic/claude-sonnet-4         # specific model
```

## The `/api` command

```
/api                    show key status (masked)
/api sk-or-...          save the key to ~/.ilides/auth.json (chmod 600)
/api remove             delete the stored key
```

The stored key is loaded automatically on every start; an `OPENROUTER_API_KEY` env var (if present) always wins. The key never appears in full in the UI, in sessions or in the repository.

## Subagents

The main agent can delegate subtasks with the **`task`** tool:

- Each subagent has its own conversation and its own `/undo`: the main context stays clean.
- It uses the same model and permission mode as the session (change it with `/model`).
- It cannot launch more subagents or use `think` (no runaway recursion).
- It returns a single final report with conclusions and touched files.

Commands and settings:

- `/agents` — explains how they work.
- `/set maxSubagentIterations 15` — iteration cap per subagent.

## Agent tools

| Tool | Description |
|---|---|
| `read_file` | line numbers, `offset/limit` for large files |
| `write_file` / `edit_file` | full write / surgical replace with ambiguity detection |
| `glob` / `search` / `list_files` | discover files and search text (`grep` fallback without ripgrep) |
| `terminal_exec` | shell commands with exit code, duration and stderr separated |
| `git_status` | short git status |
| `move_path` / `delete_file` | move/rename/delete (recoverable with `/undo`) |
| `task` | delegate to an isolated subagent |
| `todo_write` | visible step plan for multi-step tasks |
| `think` | private reasoning before acting |

## Interactive session

```
/help        list of commands
/api         set, show or remove the OpenRouter API key
/new         new conversation (resets context)
/resume      resume a previous session
/model       OpenRouter model catalog
/set         temperature, maxIterations, maxSubagentIterations, budget…
/permissions readonly | ask | auto
/undo        undo the last file change
/compact     summarize history to free up context
/cost        tokens and estimated cost in USD
/agents      how subagents work
```

- `Ctrl+C` cancels the current task and keeps the context; pressing it twice exits.
- Multi-line input by ending a line with `\`.
- The agent reads the project's `ILIDES.md` on startup (the equivalent of `CLAUDE.md`).

## Permissions

- `readonly` — no writes, no terminal.
- `ask` (default) — asks before writes and risky commands.
- `auto` — approves everything (use with care).

## Development

```bash
npm run dev     # run src/ directly with tsx
npm test        # 14 tests (node:test)
npm run build   # tsc + standalone bundle in dist/
```

Layout: `src/cli` (REPL and non-interactive mode), `src/agent` (agent loop and subagents), `src/tools` (tools + security), `src/config`, `src/providers/openrouter`, `src/session`.

## Contributing

Issues and pull requests are welcome. Run `npm test` and `npm run build` before sending changes.

## License

[MIT](LICENSE)
