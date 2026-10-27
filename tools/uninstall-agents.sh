#!/bin/bash
# Unloads the IS launchd agents (the control panel com.is.control included) and removes them from
# ~/Library/LaunchAgents (docs/RUNBOOK.md):
#   tools/uninstall-agents.sh
# Safe to run again. ~/.cloudflared/config.yml, the log folder and data/ are left as they are.
set -uo pipefail

DOMAIN_UID="gui/$(id -u)"

for label in com.is.control com.is.nightly com.is.tunnel com.is.server com.is.strass; do
  if launchctl print "$DOMAIN_UID/$label" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN_UID/$label" 2>/dev/null || true
    echo "Unloaded $label."
  fi
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done

echo "Done. The IS agents are stopped and will not start at login."
