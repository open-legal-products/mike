#!/usr/bin/env bash
# Regression test for scripts/stack.sh gc. Needs a running Docker daemon.
#
#   bash scripts/stack.test.sh
#
# It creates throwaway Compose projects that mimic the real leftovers (all
# named gctest-*, all removed at the end) and checks that the sweep removes
# exactly the ones it should:
#
#   mike-gctest-stopped   stopped, built from a copy of this repo's compose
#                         file          -> containers + network removed, data
#                                          volume kept (stack is young)
#   mike-gctest-gone      stopped, checkout directory deleted
#                                       -> removed (orphan)
#   mike-gctest-running   running       -> untouched, listed with its stop cmd
#   gctest-other          stopped, someone else's compose file
#                                       -> untouched
#   gctest-supa           stopped, labelled like a Supabase CLI stack whose
#                         id is in MIKE_GC_SUPABASE_PROJECTS
#                                       -> removed, data volume kept (young)
#   then MIKE_GC_VOLUME_AGE_DAYS=0      -> the kept data volumes are removed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="$ROOT/scripts/stack.sh"
# Confine every sweep to the fixtures so the test never touches real stacks.
export MIKE_GC_ONLY='*gctest*'
export MIKE_GC_SUPABASE_PROJECTS=gctest-supa
WORK="$(mktemp -d "${TMPDIR:-/tmp}/stack-gc-test.XXXXXX")"
FAILED=0

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=1; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

cleanup() {
    for p in mike-gctest-stopped mike-gctest-gone mike-gctest-running gctest-other; do
        docker compose -p "$p" down -v --remove-orphans >/dev/null 2>&1 || true
    done
    docker rm -f supabase_db_gctest-supa supabase_rest_gctest-supa >/dev/null 2>&1 || true
    docker network rm supabase_network_gctest-supa >/dev/null 2>&1 || true
    docker volume rm supabase_db_gctest-supa >/dev/null 2>&1 || true
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
    docker stop "supabase_db_$id" "supabase_rest_$id" >/dev/null
}

containers() { docker ps -a -q --filter "label=com.docker.compose.project=$1" | wc -l | tr -d ' '; }
volumes()    { docker volume ls -q --filter "label=com.docker.compose.project=$1" | wc -l | tr -d ' '; }

echo "Creating fixtures in $WORK"
docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; exit 1; }
docker pull -q alpine:3.20 >/dev/null

fixture "$WORK/stopped" mike
fixture "$WORK/gone"    mike
fixture "$WORK/running" mike
fixture "$WORK/other"   none

(cd "$WORK/stopped" && docker compose -p mike-gctest-stopped up -d >/dev/null 2>&1 && docker compose -p mike-gctest-stopped stop >/dev/null 2>&1)
(cd "$WORK/gone"    && docker compose -p mike-gctest-gone    up -d >/dev/null 2>&1 && docker compose -p mike-gctest-gone    stop >/dev/null 2>&1)
rm -rf "$WORK/gone"
(cd "$WORK/running" && docker compose -p mike-gctest-running up -d >/dev/null 2>&1)
(cd "$WORK/other"   && docker compose -p gctest-other         up -d >/dev/null 2>&1 && docker compose -p gctest-other         stop >/dev/null 2>&1)
supa_fixture gctest-supa

echo "Before:"
for p in mike-gctest-stopped mike-gctest-gone mike-gctest-running gctest-other gctest-supa; do
    printf '  %-22s containers=%s volumes=%s\n' "$p" "$(containers "$p")" "$(volumes "$p")"
done

echo "Dry run must change nothing:"
OUT="$(cd "$ROOT" && bash "$STACK" gc --dry-run)"
check "dry run plans the stopped stack"   '[ "$(containers mike-gctest-stopped)" = 2 ] && grep -q "mike-gctest-stopped down" <<<"$OUT"'
check "dry run plans the orphan"          '[ "$(containers mike-gctest-gone)" = 2 ] && grep -q "mike-gctest-gone down" <<<"$OUT"'
check "dry run lists the running stack"   'grep -q "running, left alone: mike-gctest-running" <<<"$OUT"'
check "dry run ignores the foreign stack" '! grep -q "gctest-other" <<<"$OUT"'

echo "Real sweep (7-day volume threshold):"
(cd "$ROOT" && bash "$STACK" gc >"$WORK/gc.log" 2>&1) || { cat "$WORK/gc.log"; fail "gc exited non-zero"; }
check "stopped stack: containers removed"     '[ "$(containers mike-gctest-stopped)" = 0 ]'
check "stopped stack: network removed"        '[ -z "$(docker network ls -q --filter label=com.docker.compose.project=mike-gctest-stopped)" ]'
check "stopped stack: young data volume kept" '[ "$(volumes mike-gctest-stopped)" = 1 ]'
check "orphan stack: containers removed"      '[ "$(containers mike-gctest-gone)" = 0 ]'
check "running stack untouched"               '[ "$(containers mike-gctest-running)" = 2 ] && [ "$(volumes mike-gctest-running)" = 1 ]'
check "foreign stack untouched"               '[ "$(containers gctest-other)" = 2 ] && [ "$(volumes gctest-other)" = 1 ]'
check "running stack listed with stop cmd"    'grep -q "scripts/stack.sh down -p mike-gctest-running" "$WORK/gc.log"'
check "supabase stack: containers removed"    '[ "$(containers gctest-supa)" = 0 ]'
check "supabase stack: network removed"       '[ -z "$(docker network ls -q --filter label=com.supabase.cli.project=gctest-supa)" ]'
check "supabase stack: young data volume kept" '[ "$(volumes gctest-supa)" = 1 ]'

echo "Sweep with a 0-day threshold removes idle data volumes:"
(cd "$ROOT" && MIKE_GC_VOLUME_AGE_DAYS=0 bash "$STACK" gc >"$WORK/gc0.log" 2>&1) || { cat "$WORK/gc0.log"; fail "gc exited non-zero"; }
check "stopped stack: data volume removed"    '[ "$(volumes mike-gctest-stopped)" = 0 ]'
check "orphan stack: data volume removed"     '[ "$(volumes mike-gctest-gone)" = 0 ]'
check "supabase stack: data volume removed"   '[ "$(volumes gctest-supa)" = 0 ]'
check "running stack volume still kept"       '[ "$(volumes mike-gctest-running)" = 1 ]'
check "foreign stack volume still kept"       '[ "$(volumes gctest-other)" = 1 ]'

echo "down --purge removes everything for the current project:"
(cd "$WORK/running" && COMPOSE_PROJECT_NAME=mike-gctest-running bash "$STACK" down --purge >/dev/null 2>&1) || fail "down --purge exited non-zero"
check "down --purge: containers gone" '[ "$(containers mike-gctest-running)" = 0 ]'
check "down --purge: volume gone"     '[ "$(volumes mike-gctest-running)" = 0 ]'

if [ "$FAILED" = 0 ]; then echo "All checks passed."; else echo "Some checks FAILED." >&2; exit 1; fi
