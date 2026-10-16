#!/usr/bin/env bash
# Regression test for scripts/stack.sh gc. Needs a running Docker daemon.
#
#   bash scripts/stack.test.sh
#
# Each run uses unique project names and an isolated cleanup record. Fixtures
# cover stopped/young stacks, deleted checkouts, running and paused services,
# known foreign mike-prefixed projects (including an unmounted data volume),
# Supabase CLI labels, repeated sweeps, dry-run parity, and explicit purge.
# The planner tests exercise old timestamps without waiting seven days:
#   node --test scripts/stack-plan.test.mjs
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="$ROOT/scripts/stack.sh"
# The existing CI job invokes this entrypoint, so run both suites here.
node --test "$ROOT/scripts/stack-plan.test.mjs"
# Confine every sweep to the fixtures so the test never touches real stacks.
RUN_ID="$(date +%s)-$$"
STOPPED="mike-gctest-$RUN_ID-stopped"
GONE="mike-gctest-$RUN_ID-gone"
RUNNING="mike-gctest-$RUN_ID-running"
OTHER="mike-gctest-$RUN_ID-other"
PAUSED="mike-gctest-$RUN_ID-paused"
SUPA="gctest-$RUN_ID-supa"
export MIKE_GC_ONLY="*gctest-$RUN_ID-*"
export MIKE_GC_SUPABASE_PROJECTS="$SUPA"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/stack-gc-test.XXXXXX")"
export MIKE_GC_STATE_DIR="$WORK/state"
export MIKE_GC_VOLUME_AGE_DAYS=7
FAILED=0

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=1; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

cleanup() {
    for p in "$STOPPED" "$GONE" "$RUNNING" "$OTHER" "$PAUSED"; do
        docker ps -aq --filter "label=com.docker.compose.project=$p" | xargs -r docker rm -f >/dev/null 2>&1 || true
        docker network ls -q --filter "label=com.docker.compose.project=$p" | xargs -r docker network rm >/dev/null 2>&1 || true
        docker volume ls -q --filter "label=com.docker.compose.project=$p" | xargs -r docker volume rm >/dev/null 2>&1 || true
    done
    docker rm -f "supabase_db_$SUPA" "supabase_rest_$SUPA" >/dev/null 2>&1 || true
    docker network rm "supabase_network_$SUPA" >/dev/null 2>&1 || true
    docker volume rm "supabase_db_$SUPA" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

# A compose project whose containers exit immediately and that declares a
# data volume, like the real stack's one-shot jobs + db_data.
fixture() {
    local dir=$1 marker=$2
    mkdir -p "$dir"
    {
        [ "$marker" = mike ] && echo "# MikeOSS — test fixture (marker line recognised by scripts/stack.sh)"
        cat <<'EOF'
services:
  job:
    image: alpine:3.20
    command: ["sh", "-c", "exit 0"]
    volumes: ["data:/data"]
  svc:
    image: alpine:3.20
    command: ["sleep", "600"]
volumes:
  data:
EOF
    } >"$dir/docker-compose.yml"
}

# The Supabase CLI does not use Compose. It creates containers, a network and
# volumes directly, labelled com.docker.compose.project=<id> AND
# com.supabase.cli.project=<id> — with no service or config_files label, so
# `docker compose -p <id> down` does not see them. Mimic that exactly.
supa_fixture() {
    local id=$1 L
    L="--label com.docker.compose.project=$id --label com.supabase.cli.project=$id"
    docker network create $L "supabase_network_$id" >/dev/null
    docker volume create $L "supabase_db_$id" >/dev/null
    docker run -d $L --name "supabase_db_$id" --network "supabase_network_$id" \
        -v "supabase_db_$id:/data" alpine:3.20 sleep 600 >/dev/null
    docker run -d $L --name "supabase_rest_$id" --network "supabase_network_$id" \
        alpine:3.20 sleep 600 >/dev/null
    docker stop -t 1 "supabase_db_$id" "supabase_rest_$id" >/dev/null
}

containers() { docker ps -a -q --filter "label=com.docker.compose.project=$1" | wc -l | tr -d ' '; }
volumes()    { docker volume ls -q --filter "label=com.docker.compose.project=$1" | wc -l | tr -d ' '; }

echo "Creating fixtures in $WORK"
docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; exit 1; }
docker image inspect alpine:3.20 >/dev/null 2>&1 || docker pull -q alpine:3.20 >/dev/null

fixture "$WORK/stopped" mike
fixture "$WORK/gone"    mike
fixture "$WORK/running" mike
fixture "$WORK/other"   none
fixture "$WORK/paused"  mike

(cd "$WORK/stopped" && docker compose -p "$STOPPED" up -d >/dev/null 2>&1 && docker compose -p "$STOPPED" stop -t 1 >/dev/null 2>&1)
(cd "$WORK/gone"    && docker compose -p "$GONE"    up -d >/dev/null 2>&1 && docker compose -p "$GONE"    stop -t 1 >/dev/null 2>&1)
rm -rf "$WORK/gone"
(cd "$WORK/running" && docker compose -p "$RUNNING" up -d >/dev/null 2>&1)
(cd "$WORK/other"   && docker compose -p "$OTHER"         up -d >/dev/null 2>&1 && docker compose -p "$OTHER"         stop -t 1 >/dev/null 2>&1)
(cd "$WORK/paused" && docker compose -p "$PAUSED" up -d >/dev/null 2>&1 && docker compose -p "$PAUSED" pause svc >/dev/null 2>&1)
# A declared but unmounted volume from a known foreign mike-prefixed project.
docker volume create --label "com.docker.compose.project=$OTHER" --label com.docker.compose.volume=unused "${OTHER}_unused" >/dev/null
supa_fixture "$SUPA"

echo "Before:"
for p in "$STOPPED" "$GONE" "$RUNNING" "$OTHER" "$SUPA"; do
    printf '  %-22s containers=%s volumes=%s\n' "$p" "$(containers "$p")" "$(volumes "$p")"
done

echo "Dry run must change nothing:"
STOPPED_ID="$(docker ps -aq --filter "label=com.docker.compose.project=$STOPPED" | head -1)"
GONE_ID="$(docker ps -aq --filter "label=com.docker.compose.project=$GONE" | head -1)"
OUT="$(cd "$ROOT" && bash "$STACK" gc --dry-run)"
check "dry run plans the stopped stack"   '[ "$(containers $STOPPED)" = 2 ] && grep -q "docker rm $STOPPED_ID" <<<"$OUT"'
check "dry run plans the orphan"          '[ "$(containers $GONE)" = 2 ] && grep -q "docker rm $GONE_ID" <<<"$OUT"'
check "dry run lists the running stack"   'grep -q "active, left alone: $RUNNING" <<<"$OUT"'
check "dry run ignores the foreign stack" '! grep -q "$OTHER" <<<"$OUT"'

check "dry run does not create a cleanup record" '[ ! -e "$MIKE_GC_STATE_DIR" ]'
OUT_ZERO="$(cd "$ROOT" && MIKE_GC_VOLUME_AGE_DAYS=0 bash "$STACK" gc --dry-run)"
check "dry run includes currently attached eligible volume" 'grep -q "docker volume rm ${STOPPED}_data" <<<"$OUT_ZERO" && [ "$(containers $STOPPED)" = 2 ]'
check "dry run protects paused stack" '! grep -q "docker volume rm ${PAUSED}_data" <<<"$OUT_ZERO" && [ "$(containers $PAUSED)" = 2 ]'
check "dry run protects foreign dangling volume" '! grep -q "docker volume rm ${OTHER}_unused" <<<"$OUT_ZERO"'

echo "State failures must not remove containers:"
printf 'not a directory\n' >"$WORK/blocked-state"
check "unwritable record location aborts before teardown" '! MIKE_GC_STATE_DIR="$WORK/blocked-state" bash "$STACK" gc >"$WORK/blocked.log" 2>&1 && [ "$(containers $STOPPED)" = 2 ]'
mkdir -p "$MIKE_GC_STATE_DIR"
DAEMON="$(docker info --format '{{.ID}}' | tr -d '\n' | tr -c '[:alnum:]_-' '_')"
STATE_FILE="$MIKE_GC_STATE_DIR/$DAEMON.json"
printf 'invalid json\n' >"$STATE_FILE"
check "malformed record aborts before teardown" '! bash "$STACK" gc >"$WORK/corrupt.log" 2>&1 && [ "$(containers $STOPPED)" = 2 ]'
rm "$STATE_FILE"
mkdir "$STATE_FILE.lock"
check "concurrent sweep lock aborts before teardown" '! bash "$STACK" gc >"$WORK/locked.log" 2>&1 && [ "$(containers $STOPPED)" = 2 ]'
rmdir "$STATE_FILE.lock"

echo "Real sweep (7-day volume threshold):"
(cd "$ROOT" && bash "$STACK" gc >"$WORK/gc.log" 2>&1) || { cat "$WORK/gc.log"; fail "gc exited non-zero"; }
check "stopped stack: containers removed"     '[ "$(containers $STOPPED)" = 0 ]'
check "stopped stack: network removed"        '[ -z "$(docker network ls -q --filter label=com.docker.compose.project=$STOPPED)" ]'
check "stopped stack: young data volume kept" '[ "$(volumes $STOPPED)" = 1 ]'
check "orphan stack: containers removed"      '[ "$(containers $GONE)" = 0 ]'
check "running stack untouched"               '[ "$(containers $RUNNING)" = 2 ] && [ "$(volumes $RUNNING)" = 1 ]'
check "foreign stack untouched"               '[ "$(containers $OTHER)" = 2 ] && [ "$(volumes $OTHER)" = 2 ]'
check "running stack listed with stop cmd"    'grep -q "scripts/stack.sh down -p $RUNNING" "$WORK/gc.log"'
check "supabase stack: containers removed"    '[ "$(containers $SUPA)" = 0 ]'
check "supabase stack: network removed"       '[ -z "$(docker network ls -q --filter label=com.supabase.cli.project=$SUPA)" ]'
check "supabase stack: young data volume kept" '[ "$(volumes $SUPA)" = 1 ]'

echo "Repeat sweep retains recently used orphaned data:"
(cd "$ROOT" && bash "$STACK" gc >"$WORK/repeat.log" 2>&1) || { cat "$WORK/repeat.log"; fail "repeat gc exited non-zero"; }
check "repeat sweep retains Compose and Supabase data" '[ "$(volumes $STOPPED)" = 1 ] && [ "$(volumes $SUPA)" = 1 ]'
check "paused stack remains paused" '[ "$(docker ps -q --filter label=com.docker.compose.project=$PAUSED --filter status=paused | wc -l | tr -d " ")" = 1 ]'

# The saved plan now describes dangling volumes. Preview and execution must
# agree, and preview must leave the persisted cleanup record byte-for-byte.
cp "$MIKE_GC_STATE_DIR/"*.json "$WORK/before.json"
OUT_ZERO="$(cd "$ROOT" && MIKE_GC_VOLUME_AGE_DAYS=0 bash "$STACK" gc --dry-run)"
check "dry run leaves existing cleanup record unchanged" 'cmp -s "$WORK/before.json" "$MIKE_GC_STATE_DIR/"*.json'
echo "Sweep with a 0-day threshold removes idle data volumes:"
(cd "$ROOT" && MIKE_GC_VOLUME_AGE_DAYS=0 bash "$STACK" gc >"$WORK/gc0.log" 2>&1) || { cat "$WORK/gc0.log"; fail "gc exited non-zero"; }
check "stopped stack: data volume removed"    '[ "$(volumes $STOPPED)" = 0 ]'
check "orphan stack: data volume removed"     '[ "$(volumes $GONE)" = 0 ]'
check "supabase stack: data volume removed"   '[ "$(volumes $SUPA)" = 0 ]'
check "running stack volume still kept"       '[ "$(volumes $RUNNING)" = 1 ]'
check "foreign stack volume still kept"       '[ "$(volumes $OTHER)" = 2 ]'

check "paused stack and its data survive a zero-day threshold" '[ "$(containers $PAUSED)" = 2 ] && [ "$(volumes $PAUSED)" = 1 ]'
printf '%s\n' "$OUT_ZERO" | sed -n 's/^  \[dry-run\] \(docker volume rm .*\)/\1/p' | sort >"$WORK/preview-volumes"
sed -n 's/^  \(docker volume rm .*\)/\1/p' "$WORK/gc0.log" | sort >"$WORK/actual-volumes"
check "preview matches executed volume removals" 'cmp -s "$WORK/preview-volumes" "$WORK/actual-volumes"'

echo "down --purge removes everything for the current project:"
(cd "$WORK/running" && COMPOSE_PROJECT_NAME="$RUNNING" bash "$STACK" down --purge >/dev/null 2>&1) || fail "down --purge exited non-zero"
check "down --purge: containers gone" '[ "$(containers $RUNNING)" = 0 ]'
check "down --purge: volume gone"     '[ "$(volumes $RUNNING)" = 0 ]'

if [ "$FAILED" = 0 ]; then echo "All checks passed."; else echo "Some checks FAILED." >&2; exit 1; fi
