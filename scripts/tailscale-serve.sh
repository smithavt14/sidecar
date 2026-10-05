#!/usr/bin/env bash
# Expose a running sidecar on your PRIVATE tailnet so you can review from your phone.
# Over the tailnet, sidecar answers only the Tailscale login this machine is signed in as, plus any
# login in SIDECAR_ALLOW_USERS. Never `tailscale funnel` it: Funnel traffic carries no login.
set -euo pipefail

PORT="${SIDECAR_PORT:-4880}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale not found. Install it first: https://tailscale.com/download" >&2
  exit 1
fi

# Reverse-proxy https://<your-machine>.<tailnet>.ts.net/ -> http://127.0.0.1:$PORT
tailscale serve --bg "$PORT"

echo
echo "sidecar is now on your tailnet:"
tailscale serve status
echo
echo "Open the printed https URL on any of your own devices (e.g. your phone)."
echo
echo "The Host allowlist blocks unknown hosts, so add your tailnet hostname to SIDECAR_HOSTS"
echo "when you start the server, e.g.:  SIDECAR_HOSTS=my-machine.tailXXXX.ts.net npm start -- <dir>"
echo "Only your own Tailscale login gets in. To let someone else in, add their login to"
echo "SIDECAR_ALLOW_USERS (comma-separated). Do NOT run 'tailscale funnel'."
