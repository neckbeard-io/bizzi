# bizzi workspace image (topology.md §7): what agent sessions of a container workspace run in when the
# repo has no devcontainer.json and no image was given. The node builds it into its Docker daemon (the
# dind sidecar) on first use, from this directory only. Rebuild by hand to update the agents:
#   docker build -t bizzi/workspace:latest packages/containers/image
#
# The node runs agents as its own uid:gid (`--user`), which has no passwd entry here: HOME is a shared,
# sticky directory any uid can write to, so ~/.claude, ~/.codex and caches work.

ARG NODE_IMAGE=node:26-trixie-slim
FROM ${NODE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/agent \
    NPM_CONFIG_PREFIX=/opt/agents \
    PATH=/opt/agents/bin:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client \
      python3 build-essential \
      ripgrep less procps jq bash \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /home/agent /opt/agents \
 && chmod 1777 /home/agent

# The ADEs bizzi drives in structured mode (Claude Code, Codex). Pin with --build-arg.
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g --no-audit --no-fund \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && rm -rf /home/agent/.npm /home/agent/.cache

WORKDIR /home/agent
