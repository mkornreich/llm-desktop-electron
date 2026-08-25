#!/usr/bin/env bash
# Free the GPU: stop every on-device inference server this project can launch (FreeToken +
# Ollama) plus their worker children, so all VRAM is released. Safe to run anytime and
# idempotent. Catches BOTH the run.sh-managed instances (pid files) and any stray `ft serve`
# started by hand during testing, then sweeps for orphaned workers still holding VRAM.
#
#   scripts/gpu-unload.sh
#
# It does NOT touch non-inference GPU processes (a desktop compositor, an unrelated CUDA job):
# the final sweep only kills PIDs whose /proc cmdline is a freetoken/ollama worker, and prints
# anything else left holding VRAM for you to inspect.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root (this script lives in scripts/)
cd "$HERE"

vram() { nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>/dev/null || echo "n/a (no nvidia-smi)"; }
echo "[gpu-unload] VRAM before: $(vram)"

# TERM then (after a grace period) KILL a process's WHOLE group. Workers share the parent's
# pgid; killing only the parent orphans them holding VRAM, so we signal the group.
gkill() {
  local pid="$1" pg
  kill -0 "$pid" 2>/dev/null || return 0
  pg="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  { [ -n "$pg" ] && kill -TERM "-$pg" 2>/dev/null; } || kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || return 0; sleep 1; done
  { [ -n "$pg" ] && kill -KILL "-$pg" 2>/dev/null; } || kill -KILL "$pid" 2>/dev/null || true
}

# 1. Managed FreeToken (pid file written by run.sh) — group-kill, then drop the stale pid file.
if [ -r user-data/freetoken-managed ]; then
  pid="$(cat user-data/freetoken-managed 2>/dev/null || true)"
  [ -n "${pid:-}" ] && { echo "[gpu-unload] stopping managed FreeToken (pid $pid + group)"; gkill "$pid"; }
  rm -f user-data/freetoken-managed
fi

# 2. Any OTHER `ft serve` processes (e.g. launched by hand during testing) + their groups.
for pid in $(pgrep -f "ft serve" 2>/dev/null || true); do
  echo "[gpu-unload] stopping stray ft serve (pid $pid + group)"; gkill "$pid"
done

# 3. Ollama — unload every resident model from VRAM with `ollama stop` (the loaded model, not the
#    daemon, is what holds the GPU). Ollama typically runs as a systemd service owned by another
#    user, so we do NOT kill the daemon — we just evict its models. Covers the default host and, if
#    we launched a managed instance, its own port (config default 11435).
if command -v ollama >/dev/null 2>&1; then
  ollama ps 2>/dev/null | awk 'NR>1 && $1!="" {print $1}' | while read -r m; do
    echo "[gpu-unload] ollama stop $m"; ollama stop "$m" 2>/dev/null || true
  done
  if [ -r user-data/ollama-managed ]; then
    OLLAMA_HOST=127.0.0.1:11435 ollama ps 2>/dev/null | awk 'NR>1 && $1!="" {print $1}' | while read -r m; do
      echo "[gpu-unload] ollama stop $m (managed :11435)"; OLLAMA_HOST=127.0.0.1:11435 ollama stop "$m" 2>/dev/null || true
    done
  fi
fi

sleep 2

# 4. Safety sweep: kill any process STILL holding GPU compute memory whose cmdline is a FreeToken
#    worker (orphaned TP scheduler / spawn worker). Ollama is handled above via `ollama stop` (its
#    daemon runs as another user and isn't ours to kill), so it is not swept here.
for pid in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null || true); do
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cmd" in
    *freetoken*|*"/ft "*)
      echo "[gpu-unload] killing GPU-resident inference worker (pid $pid)"; kill -KILL "$pid" 2>/dev/null || true;;
  esac
done
sleep 1

echo "[gpu-unload] VRAM after:  $(vram)"
remain="$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>/dev/null || true)"
if [ -n "$remain" ]; then
  echo "[gpu-unload] still holding VRAM (left untouched — inspect manually):"; echo "$remain" | sed 's/^/    /'
else
  echo "[gpu-unload] GPU compute memory clear."
fi
exit 0
