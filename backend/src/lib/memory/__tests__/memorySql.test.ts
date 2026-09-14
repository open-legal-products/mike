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
  resolve(backendRoot, "migrations/20260912_01_memory_followup.sql"),
  "utf8",
);
const sources = [
  ["schema", schemaSql],
  ["migration", memoryMigration],
] as const;

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
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
    const table = sql.slice(
      sql.indexOf("create table if not exists public.memory_files ("),
      sql.indexOf("create unique index if not exists memory_files_user_unique"),
    );
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
});
