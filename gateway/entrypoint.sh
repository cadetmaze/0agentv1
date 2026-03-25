#!/bin/sh
# Write the LLM config from the CONFIG_YAML env var injected by the gateway.
# This avoids baking API keys into the image.

set -e

mkdir -p /root/.0agent

if [ -n "$CONFIG_YAML" ]; then
  printf '%s\n' "$CONFIG_YAML" > /root/.0agent/config.yaml
fi

# Start a virtual framebuffer so pyautogui doesn't crash (even though
# most tasks won't need it — Playwright runs headlessly).
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99

# Start the 0agent daemon
exec node /usr/local/lib/node_modules/0agent/dist/daemon.mjs
