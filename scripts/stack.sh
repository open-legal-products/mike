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
# `restart: unless-stopped` brings them back after every Docker restart, and
# each checkout (worktree) or `-p` project adds another set. Nothing reclaims
# any of it, so disk and RAM fill up with stacks nobody is using. `gc` runs
# before every `up` (and from scripts/e2e-local-stack.sh) so leftovers are
# swept on the next setup instead of accumulating.
#
# What `gc` removes — only resources it can attribute to this repository:
#   1. Fully stopped Compose projects whose compose file is this repo's
#      docker-compose.yml (or whose checkout directory no longer exists and
#      whose project name starts with "mike"): containers + network go
#      (`docker compose -p NAME down`); named volumes are kept until the
#      project has been idle for MIKE_GC_VOLUME_AGE_DAYS (default 7).
#   2. Fully stopped Supabase CLI stacks for this checkout's project_id
#      (backend/supabase/config.toml) or any id in MIKE_GC_SUPABASE_PROJECTS
#      (comma-separated): same rule, data volumes kept until idle long enough.
#   3. Dangling volumes older than MIKE_GC_VOLUME_AGE_DAYS that belong to the
#      projects above, plus anonymous dangling volumes (what `docker volume
#      prune` removes by default).
#   4. Dangling images and build cache older than MIKE_GC_VOLUME_AGE_DAYS.
#   --deep additionally removes ALL unused images and ALL build cache
#   (machine-wide, Docker's own `prune -a` semantics; the next start re-pulls).
#
# What `gc` never touches: running containers (yours or anyone's — they are
# listed with the command to stop them), containers/volumes of projects it
# cannot attribute to this repo, and the Supabase CLI stacks of other ids
# (listed with the `supabase stop --project-id` command instead).
#
# Options: -p/--project NAME selects the Compose project (default:
# COMPOSE_PROJECT_NAME, else the checkout directory name — Compose's default).
# MIKE_GC=0 skips the sweep in `up` and in the e2e setup script.
# MIKE_GC_ONLY=<glob> restricts the sweep to matching project names and skips
# the machine-wide parts (anonymous volumes, images, build cache).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.yml"
AGE_DAYS="${MIKE_GC_VOLUME_AGE_DAYS:-7}"
AGE_SECS=$((AGE_DAYS * 86400))
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

# Seconds since an RFC3339 timestamp (Docker's format, nanoseconds allowed).
# Returns a huge number for Docker's zero time so "never ran" counts as idle.
age_of() {
    local ts=$1
    case "$ts" in ""|0001-01-01T*) echo 999999999; return;; esac
    jq -rn --arg t "$ts" --arg now "$(date -u +%s)" \
        '($t | sub("\\.[0-9]+"; "") | fromdateiso8601) as $e | ($now | tonumber) - $e'
}

days_ago() { echo $(( $1 / 86400 )); }

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

# Distinct project names from the inventory above.
projects_in() { cut -f1 | sort -u; }

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
gc() {
    need jq
    local inventory projects project classify config supa rows newest idle
    local running_other=0 removed_projects="" idle_projects="" running_projects=""

    log "Stack garbage collection (volume idle threshold: ${AGE_DAYS}d$( [ "$DRY_RUN" = 1 ] && echo ', dry run')${ONLY:+, only '$ONLY'})"

    inventory="$(list_compose_containers)"
    projects="$(printf '%s' "$inventory" | projects_in)"

    # --- 1. Containers + networks of fully stopped projects ----------------
    log "Stopped stacks:"
    for project in $projects; do
        [ -n "$project" ] && in_scope "$project" || continue
        rows="$(printf '%s\n' "$inventory" | awk -F'\t' -v p="$project" '$1 == p')"
        config="$(blank "$(printf '%s\n' "$rows" | head -1 | cut -f3)")"
        supa="$(blank "$(printf '%s\n' "$rows" | head -1 | cut -f4)")"
        classify="$(classify_project "$project" "$config" "$supa")"

        if printf '%s\n' "$rows" | cut -f2 | grep -qx running; then
            running_projects="$running_projects $project"
            case "$classify" in
                mike|orphan|supabase)
                    if [ "$project" != "$PROJECT" ]; then
                        running_other=1
                        if [ -n "$supa" ]; then
                            note "running, left alone: supabase cli '$supa'  (stop with: supabase stop --project-id $supa)"
                        else
                            note "running, left alone: $project  (stop with: scripts/stack.sh down -p $project)"
                        fi
                    fi;;
            esac
            continue
        fi

        # Idle time = time since the most recent container activity.
        newest="$(printf '%s\n' "$rows" | cut -f5 | sort | tail -1)"
        idle="$(age_of "$newest")"

        case "$classify" in
            mike|orphan)
                act "docker compose -p $project down --remove-orphans   # idle $(days_ago "$idle")d, $classify"
                [ "$DRY_RUN" = 1 ] || docker compose -p "$project" down --remove-orphans >/dev/null 2>&1 || true
                removed_projects="$removed_projects $project"
                [ "$idle" -ge "$AGE_SECS" ] && idle_projects="$idle_projects $project"
                ;;
            supabase)
                if supabase_allowed "$supa"; then
                    act "docker compose -p $project down --remove-orphans   # supabase cli '$supa', idle $(days_ago "$idle")d"
                    [ "$DRY_RUN" = 1 ] || docker compose -p "$project" down --remove-orphans >/dev/null 2>&1 || true
                    removed_projects="$removed_projects $project"
                    [ "$idle" -ge "$AGE_SECS" ] && idle_projects="$idle_projects $project"
                else
                    note "not mine, left alone: supabase cli '$supa'  (remove with: supabase stop --project-id $supa [--no-backup])"
                fi;;
            other)
                : ;; # someone else's stack; never touched
        esac
    done
    [ -n "$removed_projects" ] || [ "$running_other" = 1 ] || note "none"

    # --- 2. Leftover networks (project label, no containers) ----------------
    local net netproj
    docker network ls --filter label=com.docker.compose.project --format '{{.Name}}\t{{.Label "com.docker.compose.project"}}\t{{or (.Label "com.supabase.cli.project") "-"}}' |
    while IFS=$'\t' read -r net netproj supa; do
        supa="$(blank "$supa")"
        in_scope "$netproj" || continue
        printf '%s\n' "$projects" | grep -qx "$netproj" && continue   # still has containers
        if [ -n "$supa" ]; then supabase_allowed "$supa" || continue
        else case "$netproj" in mike*) ;; *) continue;; esac; fi
        act "docker network rm $net"
        [ "$DRY_RUN" = 1 ] || docker network rm "$net" >/dev/null 2>&1 || true
    done

    # --- 3. Volumes -----------------------------------------------------------
    log "Volumes (dangling, idle ≥ ${AGE_DAYS}d):"
    local vol volproj volname supaproj anon created
    docker volume ls --filter dangling=true --format '{{.Name}}' |
        xargs -r docker volume inspect |
        jq -r '.[] | [
            .Name,
            (.Labels["com.docker.compose.project"] // "-"),
            (.Labels["com.docker.compose.volume"] // "-"),
            (.Labels["com.supabase.cli.project"] // "-"),
            (if ((.Labels // {}) | has("com.docker.volume.anonymous")) then "anon" else "-" end),
            .CreatedAt
        ] | @tsv' |
    while IFS=$'\t' read -r vol volproj volname supaproj anon created; do
        volproj="$(blank "$volproj")"; supaproj="$(blank "$supaproj")"
        local mine=0 why="" idle_ok=0
        # Projects downed in step 1 are judged by how long they were idle,
        # not by when the volume was created, so a stack stopped yesterday
        # keeps its data even if it was first created months ago.
        if [ -n "$supaproj" ]; then
            in_scope "$volproj" || continue
            why="supabase cli '$supaproj'"; supabase_allowed "$supaproj" && mine=1
        elif [ "$anon" = anon ]; then
            [ -z "$ONLY" ] || continue
            why="anonymous"; mine=1
        elif [ -n "$volproj" ]; then
            in_scope "$volproj" || continue
            why="$volproj"
            case " $removed_projects " in
                *" $volproj "*) mine=1; case " $idle_projects " in *" $volproj "*) idle_ok=1;; esac;;
                *) case "$volproj" in mike*) mine=1;; esac;;
            esac
        fi
        [ "$mine" = 1 ] || continue
        # A declared-but-unmounted volume of a live stack is dangling too.
        case " $running_projects " in *" ${volproj:-/} "*) continue;; esac
        case " $removed_projects " in
            *" ${volproj:-/} "*) ;;                      # idle_ok decided above
            *) [ "$(age_of "$created")" -ge "$AGE_SECS" ] && idle_ok=1;;
        esac
        if [ "$idle_ok" != 1 ]; then
            note "kept (recently used): $vol"
            continue
        fi
        act "docker volume rm $vol   # $why"
        [ "$DRY_RUN" = 1 ] || docker volume rm "$vol" >/dev/null 2>&1 || true
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
            docker builder prune -f --filter "until=$((AGE_DAYS * 24))h" | tail -1 | sed 's/^/  /'
        fi
    fi

    log "Done. Disk use now:"
    docker system df | sed 's/^/  /'
}

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
