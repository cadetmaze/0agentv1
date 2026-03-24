# 0agent

**A persistent, learning AI agent that runs on your machine.**

```bash
npx 0agent@latest
```

That's it. 0agent installs, walks you through a 4-step setup, and starts a daemon that gets smarter with every task you run.

---

## What it does

```bash
# Sprint workflow
0agent /office-hours "I want to build a Slack bot"
0agent /plan-ceo-review
0agent /plan-eng-review
0agent /build
0agent /review
0agent /qa --url https://staging.myapp.com
0agent /ship
0agent /retro

# One-off tasks
0agent /research "Acme Corp Series B funding"
0agent /debug "TypeError at auth.ts:47"
0agent /test-writer src/payments/
0agent /refactor src/api/routes.ts

# Plain language
0agent run "fix the auth bug Marcus reported"
0agent run "research Acme Corp and draft a follow-up email to Sarah"

# Entity-scoped (learns who you are)
0agent run "pull auth metrics" --entity sarah_chen
```

---

## How it learns

Every time you run a task, 0agent records which strategy it chose and whether it worked. After 50 interactions, it converges to your optimal workflow — measurably, provably, via a weighted knowledge graph.

- Edge weights start at 0.5 (neutral)
- Positive outcomes push them toward 1.0
- Negative outcomes push them toward 0.0
- After 100 traces, plan selection is noticeably better

---

## Requirements

- **Node.js** ≥ 20
- **API key** for Anthropic, OpenAI, or a local Ollama instance
- **Docker** (optional but recommended — enables sandboxed subagents)

---

## Install

```bash
# One-liner
npx 0agent@latest

# Global install
npm install -g 0agent
0agent init

# Or via brew (coming soon)
brew install 0agent
```

---

## Local development

```bash
git clone https://github.com/0agent-oss/0agent
cd 0agent
pnpm install
pnpm build

# Run the wizard
node bin/0agent.js init

# Start daemon
node bin/0agent.js start

# Check status
node bin/0agent.js status

# Open dashboard
open http://localhost:4200
```

---

## Architecture

```
You → 0agent CLI → Daemon (port 4200) → Knowledge Graph
                                      → Subagents (sandboxed)
                                      → MCP Tools (filesystem, browser, shell)
                                      → Learning Engine (weight propagation)
```

- **Knowledge graph** — weighted, multimodal. SQLite + HNSW. Persists to `~/.0agent/graph.db`
- **Subagents** — sandboxed (Docker/Podman/process). Zero-trust capability tokens. Never write to the graph.
- **MCP** — connects to any MCP server. Built-in: filesystem, shell, browser, memory.
- **Skills** — 15 built-in YAML-defined skills. Add your own in `~/.0agent/skills/custom/`
- **Self-improvement** — weekly analysis of skill gaps, workflow optimization, prompt refinement.

---

## Entity nesting

0agent can learn individual personalities within an organization:

```yaml
# One-time setup in config
entity_nesting:
  enabled: true
  visibility_policy:
    allow_work_context: true       # company sees projects/tasks
    allow_personality_profile: false  # company can't see communication style
```

After 3+ interactions with Sarah, responses automatically match her style:
- Terse? Leads with numbers, no preamble.
- Bullet-point user? Bullets.
- Exploratory? More context and options.

The company graph sees `[from member] Sarah used /build` — not the raw conversations.

---

## Config

`~/.0agent/config.yaml` — created by `0agent init`, edit anytime:

```yaml
llm_providers:
  - provider: anthropic
    model: claude-sonnet-4-6
    api_key: sk-ant-...
    is_default: true

sandbox:
  backend: docker   # docker | podman | process | firecracker

entity_nesting:
  enabled: true

self_improvement:
  schedule: weekly
```

---

## License

Apache 2.0
