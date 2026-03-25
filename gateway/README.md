# 0agent Telegram Gateway

Multi-tenant Telegram bot — every user gets their own isolated Docker container
running the 0agent daemon. No setup required for end users.

## How it works

```
User sends message → Gateway bot → Docker container (per user) → 0agent daemon → reply
```

- First message from a user spins up a container (~3–5s)
- Container stays alive for 30 min of inactivity, then auto-destroys
- `/stop` destroys it immediately
- Each container is fully isolated (own filesystem, own memory)

## Deploy (5 minutes)

### 1. Get a bot token
Message [@BotFather](https://t.me/botfather) on Telegram:
```
/newbot
```
Copy the token.

### 2. Get a VPS
Any Linux VPS with Docker works. Minimum specs per 50 users:
- 4 vCPU, 4GB RAM, 20GB disk
- Ubuntu 22.04 or Debian 12 recommended

### 3. Install Docker on the VPS
```bash
curl -fsSL https://get.docker.com | sh
```

### 4. Build the agent image
```bash
# On your VPS, clone the repo
git clone https://github.com/cadetmaze/0agentv1
cd 0agentv1/gateway

# Build the sandbox image (used for each user's container)
docker build -f Dockerfile.agent -t 0agent-sandbox .
```

### 5. Configure and start
```bash
cp .env.example .env
# Edit .env with your tokens:
nano .env

# Start the gateway
docker compose up -d
```

### 6. Done
Share your bot username with users. They just message it — no installation needed.

## User commands

| Command | Action |
|---------|--------|
| `/start` | Welcome message |
| `/status` | Check if VM is running |
| `/stop` | Destroy VM immediately |
| Any other text | Run as a task |

## Scaling

For more users, increase `MAX_CONTAINERS` and use a bigger VPS, or run the
gateway on multiple machines with a shared Redis state (replace the in-memory
`userContainers` Map with Redis).

## Cost estimate

| Users | VPS size | Est. monthly |
|-------|----------|-------------|
| 10 concurrent | 2 vCPU / 2GB | ~$10 |
| 50 concurrent | 8 vCPU / 8GB | ~$40 |
| 200 concurrent | 32 vCPU / 32GB | ~$160 |

LLM API costs are separate (per token, charged to your Anthropic/OpenAI account).
