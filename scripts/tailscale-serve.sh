#!/usr/bin/env bash
# Expose a running sidecar on your PRIVATE tailnet so you can review from your phone.
# sidecar has no authentication — this is safe on a tailnet (only your own signed-in
# devices can reach it), but you must NEVER `tailscale funnel` it to the public internet.
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
echo "Open the printed https URL on any device signed into your tailnet (e.g. your phone)."
echo
echo "IMPORTANT: sidecar has no auth. Keep it tailnet-only — do NOT run 'tailscale funnel'."
echo "The Host allowlist blocks unknown hosts, so add your tailnet hostname to SIDECAR_HOSTS"
echo "when you start the server, e.g.:  SIDECAR_HOSTS=my-machine.tailXXXX.ts.net npm start -- <dir>"
