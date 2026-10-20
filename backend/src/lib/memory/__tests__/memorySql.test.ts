import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = resolve(__dirname, "../../../..");
const schemaSql = readFileSync(resolve(backendRoot, "schema.sql"), "utf8");
const memoryMigration = readFileSync(
  resolve(backendRoot, "migrations/20260905_01_scoped_memory_files.sql"),
  "utf8",
);
const safetyMigration = readFileSync(
  resolve(backendRoot, "migrations/20260909_01_memory_safety_boundaries.sql"),
  "utf8",
);
// #451 shipped the two migrations above; every later SQL change to memory
// objects lands in the follow-up migration and in schema.sql.
const followupMigration = readFileSync(
  resolve(backendRoot, "migrations/20260917_02_memory_followup.sql"),
  "utf8",
);
const sources = [
  ["schema", schemaSql],
  ["migration", memoryMigration],
] as const;

/** The function's definition; `last` takes the one a fresh install keeps. */
function functionBody(sql: string, name: string, last = false): string {
  const marker = `create or replace function public.${name}`;
  const start = last ? sql.lastIndexOf(marker) : sql.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe.each(sources)("%s scoped memory SQL", (_name, sql) => {
  it("opts existing accounts out and enables project memory by default", () => {
    expect(sql).toMatch(/enabled boolean not null default true/);
    expect(sql).toMatch(
      /insert into public\.memory_files\(scope, user_id, enabled\)[\s\S]*select 'user', id, false from auth\.users/,
    );
    expect(sql).toMatch(
      /insert into public\.memory_files\(scope, project_id, enabled\)[\s\S]*select 'project', id, true from public\.projects/,
    );
  });

  it("creates each project and its explicit memory setting atomically", () => {
    const body = functionBody(sql, "create_project_with_memory");
    expect(body).toContain("insert into public.projects");
    expect(body).toContain("insert into public.memory_files");
    expect(body).toContain("p_memory_enabled");
    expect(body).not.toMatch(/exception[\s\S]*delete from public\.projects/i);
  });

  it("uses per-turn leases and a conversation-global quiet generation", () => {
    const begin = functionBody(sql, "begin_memory_conversation_turn");
    const release = functionBody(sql, "release_memory_conversation_turn");
    const schedule = functionBody(sql, "schedule_memory_consolidation");
    expect(sql).toContain(
      "create table if not exists public.memory_conversation_turn_leases",
    );
    expect(begin).toContain(
      "insert into public.memory_conversation_turn_leases",
    );
    expect(begin).toContain("quiet_until");
    expect(release).toContain("activity_id = p_activity_id");
    expect(release).toContain("make_interval(secs => p_quiet_seconds)");
    expect(schedule).toContain("'appEpoch'");
    expect(schedule).toContain("'projectEpoch'");
    expect(schedule).toContain("'conversationGeneration'");
    expect(schedule).toContain("lease.activity_id = p_activity_id");
    expect(schedule).toContain("set memory_eligible_at = terminal_at");
    expect(schedule).toContain(
      "message.content @> jsonb_build_array(jsonb_build_object(",
    );
    expect(schedule).not.toContain(
      "memory_eligible_at = terminal_at, author_user_id",
    );
    expect(schedule).toContain(
      "next_conversation_generation := activity.generation + 1",
    );
    expect(schedule).toContain("project_curator_actor_user_id");
    expect(schedule).toContain("order by memory_file.id");
    expect(schedule).toContain("order by pending.actor_user_id, pending.id");
    expect(schedule).toContain("values ('project', activity.project_id, true)");
  });

  it("keeps state status updates from taking file locks in reverse order", () => {
    const stateStatus = functionBody(sql, "set_memory_consolidation_status");
    expect(stateStatus).not.toContain("update public.memory_files");
    const fileStatus = functionBody(sql, "refresh_memory_file_status");
    expect(fileStatus).toContain("job.status = 'pending'");
    expect(fileStatus).toContain("job.status = 'running'");
    expect(fileStatus).toContain("job.id <> p_current_job_id");
  });

  it("records direct-user attribution on every message table", () => {
    expect(
      sql.match(/author_user_id uuid references auth\.users\(id\)/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      sql.match(/memory_input_message_id uuid/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      sql.match(/memory_eligible_at timestamptz/g)?.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps scheduling APIs service-only", () => {
    for (const signature of [
      "begin_memory_conversation_turn\\(text, uuid, uuid, uuid, integer, integer\\)",
      "release_memory_conversation_turn\\(text, uuid, uuid, integer\\)",
      "schedule_memory_consolidation\\(text, uuid, uuid, uuid, uuid, uuid, integer\\)",
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `revoke all on function public\\.${signature}[\\s\\S]*from public, anon, authenticated`,
        ),
      );
    }
    expect(sql).toMatch(
      /grant execute\s+on function public\.schedule_memory_consolidation\(text, uuid, uuid, uuid, uuid, uuid, integer\)[\s\S]*to service_role/,
    );
  });
});

describe.each(sources)("%s direct memory writes", (_name, sql) => {
  it("fences a curator write before touching the file row", () => {
    const body = functionBody(sql, "write_memory_file");
    expect(body).toContain("memory_job_superseded");
    expect(body).toContain(
      "consolidation.generation <> p_consolidation_generation",
    );
    expect(body).toContain("activity.generation <> p_conversation_generation");
    expect(body).toContain("activity.quiet_until > now()");
    expect(body).toContain("memory_conversation_turn_leases");
    expect(body.indexOf("select * into activity")).toBeLessThan(
      body.indexOf("select * into consolidation"),
    );
    expect(body.indexOf("select * into consolidation")).toBeLessThan(
      body.indexOf("select * into target"),
    );
  });

  it("stores the body on the locked row and replays a retried job once", () => {
    const body = functionBody(sql, "write_memory_file");
    expect(body).toContain("where id = p_memory_file_id\n  for update");
    expect(body).toContain("set content = p_content");
    expect(body).toContain("content_sha256 = p_content_sha256");
    expect(body).toContain("revision = target.revision + 1");
    expect(body).toContain("last_source_job_id = p_source_job_id");
    expect(body).toMatch(
      /target\.last_source_job_id = p_source_job_id[\s\S]*return query select false, target\.revision/,
    );
    expect(body).toContain("memory_revision_conflict");
    expect(body).toContain("memory_epoch_conflict");
  });

  it("erases content while fencing in-flight learning", () => {
    const body = functionBody(sql, "wipe_memory_file");
    expect(body).toContain("content = ''");
    expect(body).toContain("content_sha256 = null");
    expect(body).toContain("size_bytes = 0");
    expect(body).toContain("target.epoch + 1");
    expect(body).toContain("target.revision + 1");
    expect(body).toContain("coalesce(p_enabled, target.enabled)");
    expect(body).not.toContain("insert into public.db_jobs");
  });
});

describe.each(sources)("%s inline memory schema", (_name, sql) => {
  it("never creates the superseded object-storage model", () => {
    for (const gone of [
      "memory_file_versions",
      "memory_object_candidates",
      "memory.candidate_cleanup",
      "claim_memory_upload_candidate",
      "fence_memory_file_delete",
    ]) {
      expect(sql).not.toContain(gone);
    }
    // The table ends where its first unique index begins: one per person
    // originally, one per person per workspace since.
    const tableStart = sql.indexOf(
      "create table if not exists public.memory_files (",
    );
    const tableEnd = [
      "create unique index if not exists memory_files_user_unique",
      "create unique index if not exists memory_files_user_personal_unique",
    ]
      .map((index) => sql.indexOf(index, tableStart))
      .find((at) => at > tableStart);
    expect(tableEnd).toBeDefined();
    const table = sql.slice(tableStart, tableEnd);
    expect(table).not.toContain("current_version_id");
    expect(table).toContain("content text not null default ''");
    expect(table).toContain("last_source_job_id uuid");
  });
});

describe.each([
  ["schema", schemaSql],
  ["safety migration", safetyMigration],
] as const)("%s memory safety boundaries", (_name, sql) => {
  it("atomically appends to the exact assistant message", () => {
    const body = functionBody(sql, "append_chat_ask_inputs_response");
    expect(body).toContain("id = p_message_id");
    expect(body).toContain("chat_id = p_chat_id");
    expect(body).toContain("for update");
    expect(body).toContain("event->>'event_id' = p_ask_event_id");
    expect(body).toContain("event->>'ask_event_id' = p_ask_event_id");
  });

});

describe.each([
  ["schema", schemaSql],
  ["follow-up migration", followupMigration],
] as const)("%s memory follow-ups", (_name, sql) => {
  it("replaces the two-argument app-memory check with the conversation-aware one", () => {
    expect(sql).toMatch(
      /grant execute\s+on function public\.memory_source_allows_app_memory\(text, uuid, uuid, uuid\)\s+to service_role/,
    );
    expect(sql).toMatch(
      /grant execute\s+on function public\.memory_project_is_private\(uuid\)\s+to service_role/,
    );
    // The two-argument form may only appear as the drop of the shipped object.
    const twoArg = sql.match(/memory_source_allows_app_memory\(text, uuid\)/g) ?? [];
    const drops = sql.match(
      /drop function if exists public\.memory_source_allows_app_memory\(text, uuid\)/g,
    ) ?? [];
    expect(twoArg.length).toBe(drops.length);
  });

  it("deletes app and private-project memory transactionally", () => {
    const body = functionBody(sql, "delete_user_private_memories");
    // Eligibility is pinned with row locks on the caller's own private
    // projects. A table-level SHARE lock also worked, but it stalled every
    // project write in the system from a user-facing DELETE route.
    expect(body).not.toContain("lock table");
    expect(body).toContain("where project.user_id = p_user_id and project.org_id is null");
    expect(body).toContain("for update;");
    expect(body).toContain("file.scope = 'user'");
    expect(body).toContain("project.org_id is null");
    expect(body).toContain("not exists (");
    expect(body).toContain("perform public.wipe_memory_file");
  });

  it("scopes app-memory eligibility to the conversation, not just the project", () => {
    const body = functionBody(sql, "memory_source_allows_app_memory");
    // A standalone chat has no project. Answering "eligible" for every such
    // chat let a chat shared with a colleague learn into the owner's private
    // app memory. The three read-path tests now apply to chat and tabular
    // alike: own conversation, no organization, no direct grants.
    expect(body).toContain("p_conversation_id");
    expect(body).toContain("p_actor_user_id");
    expect(body).toContain("public.chats");
    expect(body).toContain("public.tabular_review_chats");
    expect(body).not.toMatch(
      /when p_surface = 'chat' and p_project_id is null then true/,
    );
  });

  it("answers a lost race as P0001 so PostgREST replies instead of hanging", () => {
    // PostgREST treats SQLSTATE 40001 as a retryable transaction failure and
    // never delivered a response for it here: the browser request stayed
    // pending and the session sat "idle in transaction (aborted)".
    expect(sql).not.toMatch(/errcode = '40001'/);
    for (const conflict of [
      "memory_source_changed",
      "memory_conversation_deleted",
      "memory_job_superseded",
      "memory_epoch_conflict",
      "memory_revision_conflict",
      "memory_scope_ineligible",
    ]) {
      expect(sql).toContain(
        `raise exception using errcode = 'P0001', message = '${conflict}'`,
      );
    }
  });

  it("hardens every SECURITY DEFINER memory function with pg_temp", () => {
    for (const name of [
      "create_project_with_memory",
      "lock_memory_conversation_source",
      "begin_memory_conversation_turn",
      "release_memory_conversation_turn",
      "memory_source_allows_app_memory",
      "write_memory_file",
      "wipe_memory_file",
      "delete_user_private_memories",
      "schedule_memory_consolidation",
      "set_memory_consolidation_status",
      "refresh_memory_file_status",
    ]) {
      expect(functionBody(sql, name)).toContain(
        "set search_path = public, pg_temp",
      );
    }
  });

  it("locks only this conversation's memory files, through the unique indexes", () => {
    const body = functionBody(sql, "schedule_memory_consolidation");
    // "user_id in (subquery) or project_id = ..." under a top-level OR cannot
    // be served from either unique index, so every assistant turn scanned and
    // row-locked the whole memory_files table.
    expect(body).toContain("pending_actor_ids");
    expect(body).toContain("locked_user_file.user_id = any(pending_actor_ids)");
    expect(body).toContain("union all");
    expect(body).not.toMatch(
      /memory_file\.user_id in \([\s\S]{0,400}?\)\s*\)?\s*or\s+memory_file\.project_id/,
    );
  });

  it("raises when the consolidation state row is missing instead of doing nothing", () => {
    const body = functionBody(sql, "schedule_memory_consolidation");
    expect(body).toContain("memory_state_missing");
  });

  it("keeps an expired lease for a day so a long turn stays schedulable", () => {
    const body = functionBody(sql, "begin_memory_conversation_turn");
    // The scheduler proves a turn's activity id by deleting its own lease row.
    // Reaping every expired lease made a turn that outlived its lease silently
    // unschedulable the moment anyone else spoke.
    expect(body).toContain("expires_at <= now() - interval '1 day'");
    expect(body).not.toMatch(/and expires_at <= now\(\);/);
  });

  it("retimes deferred work to the quiet window in both directions", () => {
    const release = functionBody(sql, "release_memory_conversation_turn");
    expect(release).toContain("set run_at = next_quiet_until");
    // A flat one-minute deferral re-woke the worker every minute for as long
    // as the conversation stayed active.
    expect(release).not.toContain("interval '1 minute'");
    expect(release).not.toContain("set run_at = greatest(run_at");
  });

  it("verifies the tabular chat owner before trusting the locked source", () => {
    const body = functionBody(sql, "lock_memory_conversation_source");
    // The tabular branch reused one variable for both the pre-lock read and
    // the post-lock re-read, so its own comparison could never fail, and it
    // never re-checked the chat owner at all.
    expect(body).toContain("review_owner_user_id");
    expect(body).toContain("verified_review_owner_user_id");
    expect(body).toContain(
      "verified_owner_user_id is distinct from owner_user_id",
    );
    expect(body).toContain(
      "verified_review_owner_user_id is distinct from review_owner_user_id",
    );
  });

  it("indexes the memory tables for cascades, account erasure and the job probe", () => {
    for (const index of [
      // ON DELETE CASCADE from memory_files, and the retention sweep.
      "memory_consolidation_results_file_idx",
      "memory_consolidation_results_created_idx",
      // Account deletion follows these five user references.
      "memory_files_updated_by_idx",
      "memory_consolidation_states_actor_idx",
      "memory_conversation_activity_actor_idx",
      "memory_conversation_activity_turn_actor_idx",
      "memory_conversation_activity_project_actor_idx",
      "memory_conversation_turn_leases_actor_idx",
      // refresh_memory_file_status probes db_jobs by these JSON keys.
      "db_jobs_memory_app_epoch_idx",
      "db_jobs_memory_project_epoch_idx",
    ]) {
      expect(sql).toContain(`create index if not exists ${index}`);
    }
  });
});

describe("chat_messages index hygiene", () => {
  it("drops the single-column index the memory composite index supersedes", () => {
    // idx_chat_messages_chat(chat_id) is a strict prefix of
    // chat_messages_chat_created_id_idx(chat_id, created_at, id), so it only
    // costs a write on the hottest insert table in the product.
    expect(followupMigration).toContain(
      "drop index if exists public.idx_chat_messages_chat",
    );
    expect(schemaSql).toContain(
      "create index if not exists chat_messages_chat_created_id_idx",
    );
    expect(schemaSql).not.toContain("idx_chat_messages_chat");
  });
});

// ---------------------------------------------------------------------------
// A person's memory, per workspace (20261013_02_workspace_memory).
//
// One private file for Personal and one for each team organization the
// person belongs to. A conversation reads and learns only the memory of the
// workspace it is in. Like the checks above, these read the shipped SQL: the
// behaviour itself needs a live Postgres.
// ---------------------------------------------------------------------------

const workspaceMigration = readFileSync(
  resolve(backendRoot, "migrations/20261013_02_workspace_memory.sql"),
  "utf8",
);

// Word chats in a workspace (20261020_02_word_chat_workspaces) rewrote two
// of them since; a fresh install keeps that migration's definitions.
const wordWorkspaceMigration = readFileSync(
  resolve(backendRoot, "migrations/20261020_02_word_chat_workspaces.sql"),
  "utf8",
);

describe("per-workspace memory SQL", () => {
  it.each(["memory_source_org_id", "memory_source_allows_app_memory"])(
    "a fresh install defines %s exactly as the Word workspace migration does",
    (name) => {
      expect(functionBody(schemaSql, name, true)).toBe(
        functionBody(wordWorkspaceMigration, name),
      );
    },
  );

  it.each([
    "ensure_user_memory_file",
    "initialize_new_user_memory",
    "write_memory_file",
    "delete_user_private_memories",
    "schedule_memory_consolidation",
    "refresh_memory_file_status",
  ])("a fresh install defines %s exactly as the migration does", (name) => {
    expect(functionBody(schemaSql, name)).toBe(
      functionBody(workspaceMigration, name),
    );
  });

  it.each([
    ["schema", schemaSql],
    ["migration", workspaceMigration],
  ] as const)("%s keeps one file per person per workspace", (_name, sql) => {
    // Null is Personal and nulls are distinct, so one index each.
    expect(sql).toMatch(
      /create unique index if not exists memory_files_user_personal_unique\s+on public\.memory_files\(user_id\) where org_id is null;/,
    );
    expect(sql).toMatch(
      /create unique index if not exists memory_files_user_workspace_unique\s+on public\.memory_files\(user_id, org_id\) where org_id is not null;/,
    );
  });

  it("no longer keeps the one-file-per-person index, which would refuse a second workspace", () => {
    expect(schemaSql).not.toContain("memory_files_user_unique");
    expect(workspaceMigration).toContain(
      "drop index if exists public.memory_files_user_unique;",
    );
    // ... nor leans on it: an upsert naming (user_id) needs that index.
    for (const name of ["initialize_new_user_memory", "delete_user_private_memories"]) {
      expect(functionBody(schemaSql, name)).not.toContain(
        "on conflict (user_id)",
      );
    }
  });

  it.each([
    ["schema", schemaSql],
    ["migration", workspaceMigration],
  ] as const)(
    "%s ties a workspace memory to the membership, so leaving takes it away",
    (_name, sql) => {
      expect(sql).toMatch(
        /memory_files_workspace_member_fkey\s+foreign key \(org_id, user_id\)\s+references public\.org_members\(org_id, user_id\) on delete cascade/,
      );
    },
  );

  it("gives a standalone chat or a Word chat in a team organization a workspace", () => {
    const body = functionBody(schemaSql, "memory_source_org_id");
    expect(body).toMatch(
      /when p_surface = 'chat' then \(\s+select chat\.org_id\s+from public\.chats chat\s+where chat\.id = p_conversation_id\s+and chat\.project_id is null\s+and public\.org_is_team\(chat\.org_id\)/,
    );
    expect(body).toMatch(
      /when p_surface = 'word' then \(\s+select chat\.org_id\s+from public\.word_chats chat\s+where chat\.id = p_conversation_id\s+and public\.org_is_team\(chat\.org_id\)/,
    );
  });

  it("lets a Word chat learn only for its author, and in an organization only while they are a member", () => {
    const body = functionBody(schemaSql, "memory_source_allows_app_memory", true);
    expect(body).toMatch(
      /when p_surface = 'word' then\s+p_project_id is null\s+and exists \(\s+select 1\s+from public\.word_chats chat\s+where chat\.id = p_conversation_id\s+and chat\.user_id = p_actor_user_id\s+and \(\s+not public\.org_is_team\(chat\.org_id\)\s+or exists \(\s+select 1 from public\.active_org_members member\s+where member\.org_id = chat\.org_id\s+and member\.user_id = p_actor_user_id/,
    );
  });

  it("purges an organization's Word chats before the organization itself", () => {
    for (const sql of [schemaSql, wordWorkspaceMigration]) {
      const body = functionBody(sql, "purge_expired_organizations", true);
      const words = body.indexOf("delete from public.word_chats where org_id=org.id;");
      expect(words).toBeGreaterThan(0);
      expect(words).toBeLessThan(
        body.indexOf("delete from public.organizations where id=org.id;"),
      );
    }
  });

  it("lets an organization's chat learn only when it is standalone and its author is still a member", () => {
    const body = functionBody(schemaSql, "memory_source_allows_app_memory");
    expect(body).toMatch(
      /not public\.org_is_team\(chat\.org_id\)\s+or \(\s+chat\.project_id is null\s+and exists \(\s+select 1 from public\.org_members member\s+where member\.org_id = chat\.org_id\s+and member\.user_id = p_actor_user_id/,
    );
    // The old rule, which kept every organization chat out, is gone.
    expect(body).not.toContain("and chat.org_id is null");
  });

  it("refuses, under the row lock, a write into any workspace but the conversation's own", () => {
    const body = functionBody(schemaSql, "write_memory_file");
    const lock = body.indexOf("where id = p_memory_file_id\n  for update;");
    const fence = body.indexOf(
      "and target.org_id is distinct from\n        public.memory_source_org_id(p_source_surface, p_source_chat_id)",
    );
    expect(lock).toBeGreaterThan(0);
    expect(fence).toBeGreaterThan(lock);
    expect(body.slice(fence, fence + 240)).toContain("memory_scope_ineligible");
  });

  it("schedules and marks only the actor's file for the conversation's workspace", () => {
    const body = functionBody(schemaSql, "schedule_memory_consolidation");
    expect(body).toContain(
      "workspace_org_id := public.memory_source_org_id(p_surface, p_conversation_id);",
    );
    expect(
      body.match(/org_id is not distinct from workspace_org_id/g),
    ).toHaveLength(2);
    expect(body).toContain(
      "'appOrgId', case when app_enabled then app_file.org_id else null end,",
    );
    // No file is created for somebody by inserting directly any more.
    expect(body).not.toContain(
      "insert into public.memory_files(scope, user_id, enabled)",
    );
  });

  it("does not take a job for one of a person's memories for a job on another", () => {
    const body = functionBody(schemaSql, "refresh_memory_file_status");
    expect(
      body.match(
        /job\.payload->>'appOrgId' is not distinct from target\.org_id::text/g,
      ),
    ).toHaveLength(2);
  });

  it("starts a new workspace memory as the person left their Personal one", () => {
    const body = functionBody(schemaSql, "ensure_user_memory_file");
    expect(body).toMatch(
      /select personal\.enabled from public\.memory_files personal\s+where personal\.scope = 'user'\s+and personal\.user_id = p_user_id\s+and personal\.org_id is null/,
    );
    // ... and gives a non-member nothing.
    expect(body).toMatch(
      /if p_org_id is not null and not exists \(\s+select 1 from public\.org_members member/,
    );
  });

  it("keeps creating one out of reach of signed-in and anonymous callers", () => {
    for (const sql of [schemaSql, workspaceMigration]) {
      for (const signature of [
        "memory_source_org_id(text, uuid)",
        "ensure_user_memory_file(uuid, uuid)",
      ]) {
        expect(sql).toContain(
          `revoke all on function public.${signature}\n  from public, anon, authenticated;`,
        );
      }
    }
  });

  // `migrate.sh baseline` records earlier files without running them. Named
  // one file too far, it leaves a database that says it has the older memory
  // migration and does not; this one then failed half-way down on a function
  // that was never created. It checks first, before changing anything.
  it("stops before changing anything when the older memory migration never ran", () => {
    const guard = workspaceMigration.indexOf(
      "to_regprocedure('public.memory_project_is_private(uuid)') is null",
    );
    const firstChange = workspaceMigration.search(
      /^(alter|create|drop|insert|update|delete)\b/m,
    );
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(firstChange);
    // It names the missing file and how to apply it.
    expect(workspaceMigration).toContain(
      "message = 'This database is missing objects from 20260917_02_memory_followup.sql'",
    );
    expect(workspaceMigration).toContain(
      "-f backend/migrations/20260917_02_memory_followup.sql",
    );
    // The file it sends people to really does create what is checked for.
    for (const name of [
      "memory_project_is_private",
      "delete_user_private_memories",
      "memory_source_allows_app_memory",
    ]) {
      expect(followupMigration).toContain(
        `create or replace function public.${name}(`,
      );
    }
  });
});
