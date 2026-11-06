#!/bin/sh
# bizzi container entrypoint (node and hub images).
#  - PUID/PGID (linuxserver.io convention): the `bizzi` user/group get these ids, so files the
#    agents write to bind-mounted /workspaces belong to your host user.
#  - /data and /home/bizzi are chowned to that user (recursively only when the owner changed).
#  - starts a virtual X display (Xvfb on $DISPLAY) for headed browsers/GUI tools, unless BIZZI_XVFB=0.
#  - then execs the command (node: `node apps/cli/src/main.ts serve ...`, hub: `... hub serve ...`) as
#    `bizzi` via gosu. BIZZI_TOKEN, BIZZI_PAIR_CODE and the rest of the environment pass through unchanged.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

log() { echo "bizzi-entrypoint: $*" >&2; }

if [ "$(id -u)" = "0" ]; then
  if [ "$(id -g bizzi)" != "$PGID" ]; then
    groupmod --non-unique --gid "$PGID" bizzi
  fi
  if [ "$(id -u bizzi)" != "$PUID" ] || [ "$(id -g bizzi)" != "$PGID" ]; then
    usermod --non-unique --uid "$PUID" --gid "$PGID" bizzi
  fi

  mkdir -p /data /home/bizzi
  for dir in /data /home/bizzi; do
    if [ "$(stat -c %u:%g "$dir")" != "$PUID:$PGID" ]; then
      log "chown -R $PUID:$PGID $dir"
      chown -R "$PUID:$PGID" "$dir"
    fi
  done
  # /workspaces is a host bind mount: only fix the top level if Docker created it as root.
  if [ -d /workspaces ] && [ "$(stat -c %u /workspaces)" = "0" ]; then
    chown "$PUID:$PGID" /workspaces || true
  fi
  run_as() { exec gosu bizzi "$@"; }
else
  # already started as a non-root user (compose `user:`): nothing to adjust
  run_as() { exec "$@"; }
fi

if [ "${BIZZI_ROLE:-node}" != "hub" ] && [ -z "${BIZZI_TOKEN:-}" ]; then
  log "BIZZI_TOKEN is not set; the node's own /ws endpoint uses a random token (clients go through the hub)"
fi

if [ "${BIZZI_XVFB:-1}" != "0" ] && command -v Xvfb >/dev/null 2>&1; then
  display="${DISPLAY:-:99}"
  if [ "$(id -u)" = "0" ]; then
    gosu bizzi Xvfb "$display" -screen 0 "${BIZZI_XVFB_SCREEN:-1920x1080x24}" -nolisten tcp >/dev/null 2>&1 &
  else
    Xvfb "$display" -screen 0 "${BIZZI_XVFB_SCREEN:-1920x1080x24}" -nolisten tcp >/dev/null 2>&1 &
  fi
  export DISPLAY="$display"
fi

run_as "$@"
