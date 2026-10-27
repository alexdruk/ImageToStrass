#!/bin/bash
# Installs the IS launchd agents (spec section 15, docs/RUNBOOK.md) for the user running it, the
# control panel com.is.control (PN-05) included:
#   tools/install-agents.sh
# - fills the templates in ops/launchd/ with this repository folder, $HOME, `which node`,
#   `which cloudflared` and the log folder (IS_LOG_DIR from the environment or .env, else
#   ~/Library/Logs/PatternNifty), checks them with plutil and copies them to ~/Library/LaunchAgents;
# - writes ~/.cloudflared/config.yml from ops/cloudflared/config.yml.template with the id of the
#   named tunnel "is", only if that file does not exist yet (it is never overwritten);
# - (re)loads each agent with launchctl bootstrap gui/$UID.
# Safe to run again (after a git pull, or when node moved): each agent is unloaded and loaded anew.
# No sudo; nothing under data/ is touched. The logs stay outside the repository: launchd may not open
# files in ~/Documents (PN-03).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABELS=(com.is.strass com.is.server com.is.tunnel com.is.nightly com.is.control)
AGENTS_DIR="$HOME/Library/LaunchAgents"
CF_DIR="$HOME/.cloudflared"
CF_CONFIG="$CF_DIR/config.yml"
DOMAIN_UID="gui/$(id -u)"

fail() { echo "install-agents: $*" >&2; exit 1; }

NODE="$(command -v node)" || fail "node was not found on PATH."
CLOUDFLARED="$(command -v cloudflared)" || fail "cloudflared was not found on PATH (brew install cloudflared)."

# The log folder, as the server reads it: the environment, then .env (only that line), then the default.
if [ -z "${IS_LOG_DIR+set}" ] && [ -f "$REPO/.env" ]; then
  IS_LOG_DIR="$(sed -n 's/^IS_LOG_DIR=\([^[:space:]#]*\).*/\1/p' "$REPO/.env" | tail -n 1)"
fi
LOG_DIR="${IS_LOG_DIR:-$HOME/Library/Logs/PatternNifty}"
case "$LOG_DIR" in /*) ;; *) fail "IS_LOG_DIR must be an absolute path: $LOG_DIR" ;; esac
case "$LOG_DIR/" in "$REPO/"*) fail "IS_LOG_DIR must be outside the repository: $LOG_DIR" ;; esac

# The agents' PATH: node's and cloudflared's folders, then Homebrew and the system.
AGENT_PATH=""
for dir in "$(dirname "$NODE")" "$(dirname "$CLOUDFLARED")" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
  case ":$AGENT_PATH:" in *":$dir:"*) ;; *) AGENT_PATH="${AGENT_PATH:+$AGENT_PATH:}$dir" ;; esac
done

# The values go into XML and sed unescaped, so they must not hold & < > or |.
for value in "$REPO" "$HOME" "$NODE" "$CLOUDFLARED" "$AGENT_PATH" "$LOG_DIR"; do
  case "$value" in *[\&\<\>\|]*) fail "unsupported character in path: $value" ;; esac
done

fill() {
  sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" -e "s|__NODE__|$NODE|g" \
      -e "s|__CLOUDFLARED__|$CLOUDFLARED|g" -e "s|__PATH__|$AGENT_PATH|g" -e "s|__LOGS__|$LOG_DIR|g" "$@"
}

mkdir -p "$LOG_DIR" "$AGENTS_DIR" "$CF_DIR"

# --- cloudflared config ---------------------------------------------------------------------------
if [ -e "$CF_CONFIG" ]; then
  echo "Kept the existing $CF_CONFIG (never overwritten)."
  if grep -q "service:.*localhost" "$CF_CONFIG"; then
    echo "Warning: $CF_CONFIG mentions localhost; the origin must be http://127.0.0.1:3003." >&2
  fi
else
  TUNNEL_ID="$("$CLOUDFLARED" tunnel list --name is --output json |
    "$NODE" -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=(JSON.parse(s)||[]).find((x)=>x.name==="is");if(t)console.log(t.id)})')" || true
  [[ "$TUNNEL_ID" =~ ^[0-9a-f-]{36}$ ]] || fail "no tunnel named \"is\" found by cloudflared tunnel list."
  fill -e "s|__TUNNEL_ID__|$TUNNEL_ID|g" "$REPO/ops/cloudflared/config.yml.template" > "$CF_CONFIG"
  echo "Wrote $CF_CONFIG (tunnel $TUNNEL_ID)."
  if [ ! -f "$CF_DIR/$TUNNEL_ID.json" ]; then
    echo "Warning: the tunnel credentials $CF_DIR/$TUNNEL_ID.json are missing (docs/RUNBOOK.md)." >&2
  fi
fi

# --- launchd agents -------------------------------------------------------------------------------
for label in "${LABELS[@]}"; do
  target="$AGENTS_DIR/$label.plist"
  tmp="$(mktemp "${TMPDIR:-/tmp}/$label.XXXXXX")"
  fill "$REPO/ops/launchd/$label.plist" > "$tmp"
  plutil -lint -s "$tmp" || { rm -f "$tmp"; fail "$label.plist did not pass plutil -lint."; }

  # Unload a running copy first; bootout returns before the job is gone, so wait for it (10 s).
  if launchctl print "$DOMAIN_UID/$label" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN_UID/$label" 2>/dev/null || true
    for _ in $(seq 20); do
      launchctl print "$DOMAIN_UID/$label" >/dev/null 2>&1 || break
      sleep 0.5
    done
  fi

  mv "$tmp" "$target"
  chmod 644 "$target"
  launchctl bootstrap "$DOMAIN_UID" "$target" || fail "launchctl bootstrap $label failed."
  echo "Loaded $label."
done

# The control panel's port, as it reads it: the environment, then .env, then 3010.
if [ -z "${IS_CONTROL_PORT+set}" ] && [ -f "$REPO/.env" ]; then
  IS_CONTROL_PORT="$(sed -n 's/^IS_CONTROL_PORT=\([0-9]*\).*/\1/p' "$REPO/.env" | tail -n 1)"
fi

echo "Done. Logs: $LOG_DIR/ (also in the Console app). Health: curl http://127.0.0.1:3003/health"
echo "Control panel: http://127.0.0.1:${IS_CONTROL_PORT:-3010}"
