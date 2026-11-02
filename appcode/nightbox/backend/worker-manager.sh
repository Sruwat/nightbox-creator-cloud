#!/usr/bin/env bash
set -euo pipefail

# Traffic VPS worker autoscaler. The Primary remains the durable scheduler;
# this manager only creates/removes bounded worker containers on Traffic.

COORDINATOR_URL="${WORKER_COORDINATOR_URL:?WORKER_COORDINATOR_URL is required}"
WORKER_KEY="${WORKER_SHARED_SECRET:?WORKER_SHARED_SECRET is required}"
IMAGE="${WORKER_IMAGE:-nightbox-p4-worker:63e1fa0}"
PREFIX="${WORKER_CONTAINER_PREFIX:-nightbox-p4-worker-traffic}"
ENV_FILE="${WORKER_ENV_FILE:-/var/www/nightbox-worker-src-63e1fa0/.worker.env}"
TEMP_ROOT="${WORKER_TEMP_ROOT:-/var/lib/nightbox-worker/temp}"
MIN_REPLICAS="${WORKER_MIN_REPLICAS:-1}"
MAX_REPLICAS="${WORKER_MAX_REPLICAS:-3}"
POLL_SECONDS="${WORKER_MANAGER_POLL_SECONDS:-5}"
IDLE_DRAIN_SECONDS="${WORKER_IDLE_DRAIN_SECONDS:-90}"
MEMORY_LIMIT="${WORKER_MEMORY_LIMIT:-2g}"
CPU_LIMIT="${WORKER_CPU_LIMIT:-1.0}"

mkdir -p "$TEMP_ROOT"

json_file="$(mktemp)"
trap 'rm -f "$json_file"' EXIT

running_ids() {
  docker ps --filter "name=^/${PREFIX}-" --format '{{.Names}}' \
    | sed -n "s#^${PREFIX}-##p" | sort -n
}

running_count() { running_ids | sed '/^$/d' | wc -l | tr -d ' '; }

fetch_queue() {
  curl -fsS --max-time 20 -X POST "${COORDINATOR_URL}/internal/workers/queue-status" \
    -H "X-Worker-Key: ${WORKER_KEY}" -H 'Content-Type: application/json' \
    -d '{}' > "$json_file"
}

desired_replicas() {
  python3 - "$json_file" "$MIN_REPLICAS" "$MAX_REPLICAS" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
minimum = max(0, int(sys.argv[2]))
maximum = max(minimum, int(sys.argv[3]))
pending = max(0, int(payload.get('pending', 0)))
workers = payload.get('workers') or []
active = sum(max(0, int(w.get('activeJobs') or 0)) for w in workers if w.get('status') == 'online')
print(max(minimum, min(maximum, pending, maximum)) if pending else minimum)
PY
}

host_capacity() {
  python3 - "$MAX_REPLICAS" "$MEMORY_LIMIT" <<'PY'
import os, re, sys
maximum = int(sys.argv[1])
memory = sys.argv[2].lower()
match = re.match(r'([0-9.]+)([mg])', memory)
limit_kb = int(float(match.group(1)) * (1024**2 if match.group(2) == 'g' else 1024)) if match else 2*1024*1024
mem = {}
for line in open('/proc/meminfo'):
    key, value = line.split(':', 1)
    mem[key] = int(value.strip().split()[0])
free_kb = mem.get('MemAvailable', mem.get('MemFree', 0))
cpu = os.getloadavg()[0] / max(1, os.cpu_count() or 1)
cpu_slots = max(1, (os.cpu_count() or 1) - 1) if cpu < .75 else 1
memory_slots = max(1, free_kb // max(1, limit_kb))
print(max(1, min(maximum, cpu_slots, memory_slots)))
PY
}

start_worker() {
  local id="$1" dir="${TEMP_ROOT}/$1" name="${PREFIX}-$1"
  mkdir -p "$dir"
  docker run -d --name "$name" --restart unless-stopped --network host \
    --memory "$MEMORY_LIMIT" --cpus "$CPU_LIMIT" \
    --env-file "$ENV_FILE" -e "WORKER_ID=traffic-worker-$id" \
    -e 'WORKER_TEMP_DIR=/app/temp/worker' \
    -v "$dir:/app/temp/worker" "$IMAGE" node worker-agent.js >/dev/null
  echo "[NightBox autoscaler] started $name"
}

idle_worker_id() {
  python3 - "$json_file" "$PREFIX" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
prefix = sys.argv[2]
running = set()
import subprocess
for line in subprocess.check_output(['docker', 'ps', '--filter', f'name=^/{prefix}-', '--format', '{{.Names}}'], text=True).splitlines():
    if line.startswith(prefix + '-'):
        running.add(line.removeprefix(prefix + '-'))
for worker in sorted(payload.get('workers') or [], key=lambda item: str(item.get('id', '')), reverse=True):
    worker_id = str(worker.get('id') or '')
    short_id = worker_id.removeprefix('traffic-worker-')
    if short_id in running and int(worker.get('activeJobs') or 0) == 0:
        print(short_id)
        break
PY
}

stop_idle_worker() {
  local name="$1"
  if ! docker ps --filter "name=^/${name}$" --format '{{.Names}}' | grep -qx "$name"; then
    echo "[NightBox autoscaler] skipped missing container $name"
    return 1
  fi
  docker stop -t "$IDLE_DRAIN_SECONDS" "$name" >/dev/null || true
  docker rm "$name" >/dev/null || true
  echo "[NightBox autoscaler] stopped $name"
}

scale_once() {
  fetch_queue || { echo '[NightBox autoscaler] queue status unavailable'; return; }
  local desired capacity current next id
  desired="$(desired_replicas)"
  capacity="$(host_capacity)"
  desired=$(( desired < capacity ? desired : capacity ))
  current="$(running_count)"
  echo "[NightBox autoscaler] pending=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pending",0))' "$json_file") current=$current desired=$desired capacity=$capacity"

  while [ "$current" -lt "$desired" ]; do
    next=1
    while docker ps --format '{{.Names}}' | grep -qx "${PREFIX}-${next}"; do next=$((next + 1)); done
    start_worker "$next"
    current=$((current + 1))
  done

  while [ "$current" -gt "$desired" ]; do
    id="$(idle_worker_id || true)"
    [ -n "$id" ] || break
    stop_idle_worker "${PREFIX}-${id}" || break
    current=$((current - 1))
  done
}

echo "[NightBox autoscaler] online; min=${MIN_REPLICAS} max=${MAX_REPLICAS} image=${IMAGE}"
while true; do
  scale_once || true
  sleep "$POLL_SECONDS"
done
