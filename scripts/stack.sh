#!/usr/bin/env bash
# Lifecycle for Mike's Docker stacks: start, stop, and garbage-collect.
#
#   scripts/stack.sh up [compose up args…]      # gc, then `docker compose up`
#   scripts/stack.sh down [--purge]             # `docker compose down` (+ -v --rmi local)
#   scripts/stack.sh gc [--dry-run] [--deep]    # remove leftovers this repo created
#   scripts/stack.sh status                     # list this repo's stacks and disk use
#
# Why this exists: `docker compose stop`, `docker stop`, and Ctrl-C leave
# containers in Exited state. Exited containers pin their images and volumes,
# and each checkout (worktree) or `-p` project adds another set. Nothing reclaims
# any of it, so disk and RAM fill up with stacks nobody is using. `gc` runs
# before every `up` (and from scripts/e2e-local-stack.sh) so leftovers are
# swept on the next setup instead of accumulating.
#
# What `gc` removes — only resources it can attribute to this repository:
#   1. Fully stopped Compose projects whose compose file is this repo's
#      docker-compose.yml (or whose checkout directory no longer exists and
#      whose project name starts with "mike"): containers + network go
#      (non-forced `docker rm`); named volumes are kept until the
#      project has been idle for MIKE_GC_VOLUME_AGE_DAYS (default 7).
#   2. Fully stopped Supabase CLI stacks for this checkout's project_id
#      (backend/supabase/config.toml) or any id in MIKE_GC_SUPABASE_PROJECTS
#      (comma-separated): same rule, data volumes kept until idle long enough.
#   3. Volumes unreferenced after planned teardown with verified ownership
#      and enough recorded idle time. Unknown named volumes are kept. Allowed
#      Supabase and anonymous orphans start a grace period when first observed.
#   4. Dangling images, plus build cache older than MIKE_GC_VOLUME_AGE_DAYS.
#   --deep additionally removes ALL unused images and ALL build cache
#   (machine-wide, Docker's own `prune -a` semantics; the next start re-pulls).
#
# What `gc` never touches: active containers (including paused/restarting; they are
# listed with the command to stop them), containers/volumes of projects it
# cannot attribute to this repo, and the Supabase CLI stacks of other ids
# (listed with the `supabase stop --project-id` command instead).
#
# Options: -p/--project NAME selects the Compose project (default:
# COMPOSE_PROJECT_NAME, else the checkout directory name — Compose's default).
# MIKE_GC=0 skips the sweep in `up` and in the e2e setup script.
# MIKE_GC_ONLY=<glob> restricts the sweep to matching project names and skips
# the machine-wide parts (anonymous volumes, images, build cache).
# MIKE_GC_STATE_DIR overrides the shared cleanup record directory (default:
# ${XDG_STATE_HOME:-$HOME/.local/state}/mike/stack-gc). Records are isolated by
# Docker daemon and volume creation timestamp. Dry runs do not change them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.yml"
AGE_DAYS="${MIKE_GC_VOLUME_AGE_DAYS:-7}"
case "$AGE_DAYS" in ''|*[!0-9]*) printf '%s\n' 'MIKE_GC_VOLUME_AGE_DAYS must be a non-negative integer.' >&2; exit 1;; esac
AGE_SECS=$((10#$AGE_DAYS * 86400))
DRY_RUN=0
DEEP=0
PROJECT="${COMPOSE_PROJECT_NAME:-}"
ONLY="${MIKE_GC_ONLY:-}"

# True when NAME is inside the MIKE_GC_ONLY filter (or no filter is set).
in_scope() { [ -z "$ONLY" ] || case "$1" in $ONLY) true;; *) false;; esac; }

log()  { printf '%s\n' "$*"; }
act()  { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else printf '  %s\n' "$*"; fi; }
note() { printf '  %s\n' "$*"; }
die()  { printf '%s\n' "$*" >&2; exit 1; }

usage() {
    # The header comment above, up to the first line of code.
    awk 'NR > 1 && /^set -euo/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
    exit "${1:-0}"
}

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required (install it and retry)."; }

docker_ready() { docker info >/dev/null 2>&1; }

# Compose's own default project name: the directory basename, lower-cased,
# with characters outside [a-z0-9_-] dropped.
default_project() {
    basename "$ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g'
}

# Is this compose file ours? It is identified by the marker on its first lines
# rather than by path, so worktrees and renamed checkouts are all recognised.
is_mike_compose_file() { [ -f "$1" ] && head -5 "$1" | grep -q 'MikeOSS'; }

# Inventories print "-" for empty fields (a bare tab would be collapsed by
# `read`); blank() maps it back to the empty string.
blank() { [ "$1" = "-" ] && echo "" || echo "$1"; }

# ---------------------------------------------------------------------------
# Inventory helpers. Each prints one record per line.
# ---------------------------------------------------------------------------

# All containers with a compose project label:
#   project<TAB>state<TAB>config_files<TAB>supabase_project<TAB>last_activity
list_compose_containers() {
    docker ps -a --filter label=com.docker.compose.project --format '{{.ID}}' |
        xargs -r docker inspect |
        jq -r '.[] | [
            .Config.Labels["com.docker.compose.project"],
            .State.Status,
            (.Config.Labels["com.docker.compose.project.config_files"] // "-"),
            (.Config.Labels["com.supabase.cli.project"] // "-"),
            (if .State.Status == "running" then "running" else
                ([.State.FinishedAt, .State.StartedAt, .Created] | max) end)
        ] | @tsv'
}

# Classify a compose project. Prints one of:
#   mike      — this repo's docker-compose.yml, checkout still exists
#   orphan    — checkout directory is gone and the name looks like ours
#   supabase  — Supabase CLI stack (handled separately)
#   other     — not ours; never touched
classify_project() {
    local project=$1 config=$2 supa=$3
    if [ -n "$supa" ]; then echo supabase; return; fi
    if [ -z "$config" ]; then echo other; return; fi
    # config_files may list several paths separated by commas; use the first.
    local first=${config%%,*}
    if [ -e "$first" ]; then
        if is_mike_compose_file "$first"; then echo mike; else echo other; fi
    else
        case "$project" in mike*) echo orphan;; *) echo other;; esac
    fi
}

supabase_allowed() {
    local id=$1 allowed
    allowed="$(sed -n 's/^project_id *= *"\(.*\)"/\1/p' "$ROOT/backend/supabase/config.toml" 2>/dev/null | head -1)"
    allowed="$allowed,${MIKE_GC_SUPABASE_PROJECTS:-}"
    case ",$allowed," in *",$id,"*) return 0;; *) return 1;; esac
}

# ---------------------------------------------------------------------------
# gc
# ---------------------------------------------------------------------------
gc() (
    need jq
    local work state_dir state_file daemon lock_owned=0 state_tmp=""
    work="$(mktemp -d)"
    trap 'rm -rf "$work"; [ -z "$state_tmp" ] || rm -f "$state_tmp"; [ "$lock_owned" = 0 ] || rmdir "$state_file.lock"' EXIT
    state_dir="${MIKE_GC_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/mike/stack-gc}"
    daemon="$(docker info --format '{{.ID}}')"
    [ -n "$daemon" ] || die "Cannot identify the Docker daemon; refusing cleanup."
    state_file="$state_dir/$(printf '%s' "$daemon" | tr -c '[:alnum:]_-' '_').json"
    # Serialize real sweeps across worktrees. A dry run only reads the last
    # atomically published record and never changes it.
    if [ "$DRY_RUN" != 1 ]; then
        mkdir -p "$state_dir"
        if ! mkdir "$state_file.lock" 2>/dev/null; then
            die "Cleanup is locked: $state_file.lock (another sweep may be running)."
        fi
        lock_owned=1
    fi
    if [ -f "$state_file" ]; then
        jq -e 'type == "object" and .version == 1 and (.volumes | type == "object")' "$state_file" >/dev/null ||
            die "Invalid cleanup record: $state_file; refusing cleanup."
        cp "$state_file" "$work/state.json"
    else
        printf '{"version":1,"volumes":{}}\n' >"$work/state.json"
    fi

    log "Stack garbage collection (volume idle threshold: ${AGE_DAYS}d$( [ "$DRY_RUN" = 1 ] && echo ', dry run')${ONLY:+, only '$ONLY'})"
    # Include non-Compose containers: they may hold volumes shared with a
    # stopped Compose project. Slurp handles multiple xargs inspect batches.
    docker ps -aq | xargs -r docker inspect | jq -s 'add // []' >"$work/containers.json"
    docker volume ls -q | xargs -r docker volume inspect | jq -s 'add // []' >"$work/volumes.json"
    jq -r '.[] | select(.Config.Labels["com.docker.compose.project"] != null) |
        [.Config.Labels["com.docker.compose.project"],
         (.Config.Labels["com.docker.compose.project.config_files"] // "-"),
         (.Config.Labels["com.supabase.cli.project"] // "-")] | @tsv' \
        "$work/containers.json" >"$work/inventory.tsv"
    { cut -f1 "$work/inventory.tsv"; jq -r '.[] |
        (.Labels["com.docker.compose.project"] // .Labels["com.supabase.cli.project"] // empty)' "$work/volumes.json"; } |
        sort -u >"$work/projects.txt"
    local project config supa kind classification scope
    : >"$work/projects.tsv"
    while IFS= read -r project; do
        [ -n "$project" ] || continue
        classification=unknown
        # Every container must agree on ownership; a foreign member vetoes it.
        while IFS=$'\t' read -r config supa; do
            [ -n "$config" ] || continue
            config="$(blank "$config")"; supa="$(blank "$supa")"
            kind="$(classify_project "$project" "$config" "$supa")"
            if [ "$kind" = supabase ] && ! supabase_allowed "$supa"; then kind=other; fi
            if [ "$classification" = unknown ]; then classification=$kind
            elif [ "$classification" != "$kind" ]; then classification=other; break; fi
        done < <(awk -F'\t' -v p="$project" '$1 == p {print $2 "\t" $3}' "$work/inventory.tsv")
        scope=false; if in_scope "$project"; then scope=true; fi
        printf '%s\t%s\t%s\n' "$project" "$classification" "$scope" >>"$work/projects.tsv"
    done <"$work/projects.txt"
    local allowed
    allowed="$(sed -n 's/^project_id *= *"\(.*\)"/\1/p' "$ROOT/backend/supabase/config.toml" | head -1),${MIKE_GC_SUPABASE_PROJECTS:-}"
    jq -n --slurpfile containers "$work/containers.json" --slurpfile volumes "$work/volumes.json" \
        --slurpfile previous "$work/state.json" --rawfile classifications "$work/projects.tsv" \
        --arg allowed "$allowed" --arg only "$ONLY" --argjson now "$(date -u +%s)" \
        --argjson age "$AGE_SECS" -f "$ROOT/scripts/stack-volumes.jq" >"$work/plan.json"
    # Persist ownership and activity BEFORE removing any container. If writing
    # fails, its last-use evidence remains in Docker and nothing is deleted.
    if [ "$DRY_RUN" != 1 ]; then
        state_tmp="$(mktemp "$state_dir/.state.XXXXXX")"
        jq '.state' "$work/plan.json" >"$state_tmp"
        mv "$state_tmp" "$state_file"
        state_tmp=""
    fi

    log "Stopped stacks:"
    awk -F'\t' '$3 != "-" {print $1 "\t" $3}' "$work/inventory.tsv" | sort -u |
    while IFS=$'\t' read -r project supa; do
        in_scope "$project" || continue
        if ! supabase_allowed "$supa"; then
            note "not mine, left alone: supabase cli '$supa' (stop with: supabase stop --project-id $supa)"
        fi
    done
    jq -r '.protected[]' "$work/plan.json" | while IFS= read -r project; do
        note "active, left alone: $project (stop with: scripts/stack.sh down -p $project; for CLI stacks use supabase stop --project-id $project)"
    done
    # Never force removal or use compose down here: a container may have
    # started/paused since the snapshot. Docker rm refuses active containers.
    jq -r '.containers[]' "$work/plan.json" | while IFS= read -r id; do
        act "docker rm $id"
        if [ "$DRY_RUN" != 1 ]; then
            docker rm "$id" >/dev/null || note "kept container $id (removal failed; it may have become active)"
        fi
    done

    local net netproj
    docker network ls --filter label=com.docker.compose.project --format '{{.Name}}\t{{.Label "com.docker.compose.project"}}' |
    while IFS=$'\t' read -r net netproj; do
        jq -e --arg p "$netproj" '.removed_projects | index($p) != null' "$work/plan.json" >/dev/null || continue
        act "docker network rm $net"
        [ "$DRY_RUN" = 1 ] || docker network rm "$net" >/dev/null || note "kept network $net (still in use or removal failed)"
    done

    log "Volumes (unreferenced after planned teardown, idle ≥ ${AGE_DAYS}d):"
    local vol
    jq -r '.kept[]' "$work/plan.json" | while IFS= read -r vol; do
        note "kept (recently used or still referenced): $vol"
    done
    jq -r '.remove[]' "$work/plan.json" | while IFS= read -r vol; do
        act "docker volume rm $vol"
        # Docker refuses volumes referenced by any container, including one
        # created after the snapshot. Never force removal.
        [ "$DRY_RUN" = 1 ] || docker volume rm "$vol" >/dev/null || note "kept volume $vol (still in use or removal failed)"
    done

    # --- 4. Images and build cache ----------------------------------------
    log "Images and build cache:"
    if [ -n "$ONLY" ]; then
        note "skipped (MIKE_GC_ONLY is set)"
    elif [ "$DEEP" = 1 ]; then
        act "docker image prune -a -f          # all unused images (machine-wide)"
        act "docker builder prune -a -f        # all build cache"
        if [ "$DRY_RUN" != 1 ]; then
            docker image prune -a -f | tail -1 | sed 's/^/  /'
            docker builder prune -a -f | tail -1 | sed 's/^/  /'
        fi
    else
        act "docker image prune -f             # dangling images only"
        act "docker builder prune -f --filter until=${AGE_DAYS}d"
        if [ "$DRY_RUN" != 1 ]; then
            docker image prune -f | tail -1 | sed 's/^/  /'
            docker builder prune -f --filter "until=$((AGE_SECS / 3600))h" | tail -1 | sed 's/^/  /'
        fi
    fi

    log "Done. Disk use now:"
    docker system df | sed 's/^/  /'
)

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------
status() {
    need jq
    log "Compose project for this checkout: $PROJECT"
    log "Containers from this repo (and Supabase CLI stacks):"
    list_compose_containers | while IFS=$'\t' read -r project state config supa last; do
        config="$(blank "$config")"; supa="$(blank "$supa")"
        classify="$(classify_project "$project" "$config" "$supa")"
        [ "$classify" = other ] && continue
        printf '  %-28s %-9s %s\n' "$project" "$state" "${supa:+supabase cli '$supa'}"
    done | sort | uniq -c | sed 's/^ *\([0-9]*\) /  \1× /'
    log "Volumes:"
    docker volume ls --format '{{.Name}}\t{{.Label "com.docker.compose.project"}}' |
        awk -F'\t' '$2 ~ /^mike/ || $1 ~ /^supabase_/ { print "  " $1 }'
    log "Disk:"
    docker system df | sed 's/^/  /'
}

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------
[ $# -ge 1 ] || usage 1
CMD=$1; shift
PASSTHRU=()
PURGE=0
while [ $# -gt 0 ]; do
    case "$1" in
        -p|--project) PROJECT=$2; shift 2;;
        --project=*)  PROJECT=${1#*=}; shift;;
        --dry-run)    DRY_RUN=1; shift;;
        --deep)       DEEP=1; shift;;
        --purge)      PURGE=1; shift;;
        -h|--help)    usage 0;;
        --)           shift; PASSTHRU+=("$@"); break;;
        *)            PASSTHRU+=("$1"); shift;;
    esac
done
[ -n "$PROJECT" ] || PROJECT="$(default_project)"

case "$CMD" in
    up)
        docker_ready || die "Docker is not running — start it first (open -a Docker) and retry."
        if [ "${MIKE_GC:-1}" != 0 ]; then gc; log; fi
        log "Starting compose project '$PROJECT'"
        exec docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up ${PASSTHRU[@]+"${PASSTHRU[@]}"}
        ;;
    down)
        docker_ready || die "Docker is not running."
        if [ "$PURGE" = 1 ]; then
            log "Removing compose project '$PROJECT' including its data volumes and local images"
            exec docker compose -p "$PROJECT" down -v --rmi local --remove-orphans ${PASSTHRU[@]+"${PASSTHRU[@]}"}
        else
            log "Stopping compose project '$PROJECT' (data volumes kept; add --purge to delete them)"
            exec docker compose -p "$PROJECT" down --remove-orphans ${PASSTHRU[@]+"${PASSTHRU[@]}"}
        fi
        ;;
    gc)
        docker_ready || die "Docker is not running."
        gc
        ;;
    status)
        docker_ready || die "Docker is not running."
        status
        ;;
    *) usage 1;;
esac
