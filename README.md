# 0agent

**A persistent, learning AI agent that runs on your machine.**

> Runs a local daemon. Learns from every task. Remembers everything. Gets better over time.

```bash
npx 0agent@latest
```

[![npm](https://img.shields.io/npm/v/0agent?color=black&label=npm)](https://www.npmjs.com/package/0agent)
[![license](https://img.shields.io/badge/license-Apache%202.0-black)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-black)](https://nodejs.org)

---

## What is this?

0agent is a CLI agent that runs as a background daemon on your machine. It executes real tasks — shell commands, file operations, web search, browser automation — using your API key, and learns from every outcome via a weighted knowledge graph.

Unlike chat-based AI tools, 0agent:

- **Persists** — runs in the background, remembers past sessions
- **Learns** — every task outcome updates edge weights in a graph; plan selection improves over time
- **Executes** — actually runs commands, writes files, searches the web, opens browsers
- **Syncs** — optionally backs up the knowledge graph to a private GitHub repo

---

## Quick start

```bash
npx 0agent@latest
```

The wizard asks for:
1. LLM provider + API key (Anthropic, OpenAI, xAI, Gemini, or local Ollama)
2. GitHub repo for memory backup (optional, uses `gh` CLI if installed)
3. Workspace folder (where the agent creates files — default: `~/0agent-workspace`)
4. Embedding provider (for semantic memory search)

After setup, the chat TUI opens automatically. No manual steps.

---

## Usage

### Interactive chat

```bash
0agent          # open chat (starts daemon if needed)
npx 0agent@latest
```

```
  0agent — anthropic/claude-sonnet-4-6
  Type a task, or /help for commands.

  › make a website for my coffee shop and deploy it locally
  › build a REST API in Go with auth
  › research my competitor's pricing and draft a response strategy
```

Type while the agent works — messages queue automatically and run one after another.

### Slash skills

```bash
# Software engineering
0agent /review           # code review current branch
0agent /build            # run build, fix errors
0agent /qa               # generate and run tests
0agent /debug            # debug a failing test or error
0agent /refactor         # refactor a file or module
0agent /test-writer      # write unit tests
0agent /doc              # generate documentation

# Planning & strategy
0agent /office-hours "I want to build a payments feature"
0agent /plan-eng-review
0agent /plan-ceo-review
0agent /retro            # weekly retrospective
0agent /ship             # pre-release checklist

# Research
0agent /research "Acme Corp Series B"
0agent /security-audit
```

### Scheduled tasks

```
  › /schedule add "run /retro" every Friday at 5pm
  › /schedule add "check the build" every day at 9am
  › /schedule list
```

### Commands

| Command | Description |
|---|---|
| `/model` | Show or switch model |
| `/model add anthropic sk-ant-...` | Add a provider API key |
| `/key anthropic sk-ant-...` | Update a stored key |
| `/status` | Daemon health + graph stats |
| `/skills` | List available skills |
| `/schedule` | Manage scheduled jobs |
| `/update` | Update to latest version |
| `/graph` | Open 3D knowledge graph |
| `/clear` | Clear screen |
| `Ctrl+C` | Cancel current task |

---

## How it learns

Every task updates a weighted knowledge graph stored in `~/.0agent/graph.db`.

```
Edge weights:  0.0 ──── 0.5 ──── 1.0
               bad    neutral   good

After each task:
  success → weight += 0.1 × learning_rate
  failure → weight -= 0.1 × learning_rate
  decay   → weight → 0.5 over time (forgetting)
```

After ~50 interactions, plan selection measurably improves. The graph also stores:
- Discovered facts: URLs, ports, file paths, API endpoints (via `memory_write` tool)
- Conversation history (last 8 exchanges injected as context)
- Identity + personality per entity

---

## Memory sync

0agent can back up its knowledge graph to a private GitHub repo:

```bash
# Set up during init, or add manually to ~/.0agent/config.yaml:
github_memory:
  enabled: true
  token: ghp_...
  owner: your-username
  repo: 0agent-memory
```

- **Pulls** on daemon start
- **Pushes** every 30 minutes if there are changes
- **Final push** on daemon shutdown
- The same repo doubles as a GitHub Codespace template for browser sessions

---

## What can the agent actually do?

| Capability | How |
|---|---|
| Run shell commands | `shell_exec` — bash, any CLI tool |
| Read / write files | `file_op` — read, write, list, mkdir |
| Search the web | `web_search` — DuckDuckGo, no API key needed |
| Scrape pages | `scrape_url` — full page text, tables, links |
| Open browser | `browser_open` — system Chrome or default OS browser |
| Remember facts | `memory_write` — persists to knowledge graph |
| Schedule tasks | Natural language cron via `/schedule` |
| Self-heal | Detects runtime errors, proposes + applies patches |

---

## Architecture

```
npx 0agent@latest
       │
       ▼
  ┌─────────────────────────────────────────────────────────┐
  │  CLI (bin/0agent.js + bin/chat.js)                      │
  │  • Init wizard  • Chat TUI  • Slash commands            │
  └───────────────────────┬─────────────────────────────────┘
                          │ HTTP + WebSocket
                          ▼
  ┌─────────────────────────────────────────────────────────┐
  │  Daemon (dist/daemon.mjs) — port 4200                   │
  │                                                         │
  │  SessionManager ── AgentExecutor ── LLMExecutor         │
  │       │                  │               │              │
  │       │            CapabilityRegistry    │              │
  │       │            • shell_exec          │              │
  │       │            • file_op             │              │
  │       │            • web_search          │              │
  │       │            • scrape_url          │              │
  │       │            • browser_open        │              │
  │       │            • memory_write        │              │
  │       │                                  │              │
  │  KnowledgeGraph ◄────── outcome feedback ┘              │
  │  (SQLite + HNSW)                                        │
  │       │                                                 │
  │  GitHubMemorySync ── SchedulerManager ── SelfHealLoop   │
  └─────────────────────────────────────────────────────────┘
```

**Key packages:**

| Package | Description |
|---|---|
| `packages/core` | Knowledge graph, inference engine, storage adapters |
| `packages/daemon` | HTTP server, session manager, agent executor, capabilities |
| `bin/chat.js` | Claude Code-style TUI with message queue, WS events, spinner |
| `bin/0agent.js` | CLI entry point, init wizard, daemon lifecycle |

---

## Configuration

`~/.0agent/config.yaml` — created by `0agent init`, edit anytime:

```yaml
llm_providers:
  - provider: anthropic
    model: claude-sonnet-4-6
    api_key: sk-ant-...        # never committed to git
    is_default: true

workspace:
  path: /Users/you/0agent-workspace   # agent creates files here

sandbox:
  backend: docker   # docker | podman | process | firecracker

github_memory:
  enabled: true
  token: ghp_...
  owner: your-username
  repo: 0agent-memory

embedding:
  provider: nomic-ollama   # nomic-ollama | openai | none
  model: nomic-embed-text
  dimensions: 768
```

---

## Local development

```bash
git clone https://github.com/cadetmaze/0agentv1
cd 0agentv1
pnpm install
pnpm build

# Run init wizard
node bin/0agent.js init

# Or start daemon directly
node bin/0agent.js start
node bin/chat.js

# Bundle daemon into single file
node scripts/bundle.mjs

# Check status
node bin/0agent.js status
open http://localhost:4200    # 3D knowledge graph dashboard
```

**Requirements:**
- Node.js ≥ 20
- pnpm (`npm install -g pnpm`)
- API key for Anthropic, OpenAI, xAI, Gemini, or a local Ollama instance
- Docker (optional — enables sandboxed execution)

---

## Roadmap

- [ ] Telegram bot interface
- [ ] MCP server support (connect to external tools)
- [ ] Team collaboration (shared graph, sync via GitHub)
- [ ] Mobile companion app
- [ ] Plugin SDK for custom capabilities

---

## Contributing

Issues and PRs welcome. This is early-stage software — things break, APIs change.

1. Fork the repo
2. `pnpm install && pnpm build`
3. Make changes to `packages/daemon/src/` or `bin/`
4. `node scripts/bundle.mjs` to rebuild the bundle
5. Test with `node bin/0agent.js init`
6. Submit a PR

---

## License

[Apache 2.0](LICENSE) — use it, fork it, build on it.
