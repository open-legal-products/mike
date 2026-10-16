# One snapshot drives both dry-run output and execution. Last-use records are
# scoped to a Docker daemon by stack.sh and to a volume incarnation here.
def project: .Config.Labels["com.docker.compose.project"] // "";
def stopped: .State.Status as $s | ["exited", "dead", "created"] | index($s) != null;
def epoch: try (sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601) catch $now;
def activity: [.State.FinishedAt, .State.StartedAt, .Created] | map(epoch) | max;

($classifications | split("\n") | map(select(length > 0) | split("\t") |
    {key: .[0], value: {kind: .[1], scope: (.[2] == "true")}}) | from_entries) as $classes |
($containers[0]) as $cs |
($volumes[0]) as $vs |
($classes | with_entries(
    .key as $p | .value += {
        members: [$cs[] | select(project == $p)],
        owned: (["mike", "orphan", "supabase"] | index($classes[$p].kind) != null)
    } |
    .value.removable = (.value.scope and .value.owned and (.value.members | length > 0) and
        (.value.members | all(stopped)))
)) as $projects |
[$projects[] | select(.removable) | .members[].Id] as $removed |
($allowed | split(",") | map(select(length > 0))) as $allowed_supa |
reduce $vs[] as $v (
    {containers: $removed,
     removed_projects: [$projects | to_entries[] | select(.value.removable) | .key],
     protected: [$projects | to_entries[] | select(.value.scope and .value.owned and
        (.value.members | any(stopped | not))) | .key],
     state: {version: 1, volumes: {}}, remove: [], kept: []};
    ($v.Labels // {}) as $labels |
    ($labels["com.docker.compose.project"] // $labels["com.supabase.cli.project"] // "") as $p |
    ($labels["com.supabase.cli.project"] // "") as $supa |
    ($labels | has("com.docker.volume.anonymous")) as $anon |
    ($projects[$p] // {kind: "unknown", members: [], owned: false, scope: false}) as $pr |
    ($previous[0].volumes[$v.Name] | if .created == $v.CreatedAt and .project == $p and .supabase == $supa
        then . else null end) as $old |
    (if $p != "" then $pr.scope else ($anon and $only == "") end) as $scope |
    # A known foreign project always vetoes a saved ownership record or name.
    # Unknown named volumes need a previous verified record; a mike* prefix
    # alone is insufficient when no containers establish provenance.
    (if $pr.kind == "other" then false
     elif $supa != "" then ($allowed_supa | index($supa) != null)
     elif $anon and $p == "" then true
     elif $pr.owned then true
     else ($pr.kind == "unknown" and $old != null) end) as $mine |
    if $scope | not then
        if $old != null then .state.volumes[$v.Name] = $old else . end
    elif $mine | not then .
    else
        [$cs[] | select(any(.Mounts[]?; .Type == "volume" and .Name == $v.Name))] as $refs |
        (any($refs[]; .Id as $id | $removed | index($id) == null) or
            any($pr.members[]; stopped | not)) as $busy |
        (if ($old.idle_since | type) == "number" then $old.idle_since else 0 end) as $prior |
        # While referenced outside the teardown plan, invalidate the idle
        # bound: a later manual down must start a new grace period. Otherwise
        # use actual activity or retain the prior bound for an orphan. Never use
        # the volume's creation age.
        (if $busy then null
         elif $pr.removable then ([$prior, ($pr.members | map(activity) | max)] | max)
         elif ($refs | length) > 0 then ([$prior, ($refs | map(activity) | max)] | max)
         elif $old != null and $prior > 0 then $prior
         else $now end) as $idle |
        .state.volumes[$v.Name] = {created: $v.CreatedAt, project: $p, supabase: $supa, idle_since: $idle} |
        if ($busy | not) and ($now - $idle >= $age) then .remove += [$v.Name]
        else .kept += [$v.Name] end
    end
)
