import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const backendRoot = resolve(__dirname, "../../../..");
const sources = [
  readFileSync(resolve(backendRoot, "schema.sql"), "utf8"),
  readFileSync(
    resolve(backendRoot, "migrations/20260905_01_scoped_memory_files.sql"),
    "utf8",
  ),
];

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe.each(sources.map((sql, index) => [index === 0 ? "schema" : "migration", sql]))(
  "%s scoped memory SQL",
  (_name, sql) => {
    it("backfills existing owners disabled while leaving new rows enabled by default", () => {
      expect(sql).toMatch(/enabled boolean not null default true/);
      expect(sql).toMatch(
        /insert into public\.memory_files\(scope, user_id, enabled\)[\s\S]*select 'user', id, false from auth\.users/,
      );
      expect(sql).toMatch(
        /insert into public\.memory_files\(scope, project_id, enabled\)[\s\S]*select 'project', id, false from public\.projects/,
      );
    });

    it("creates each project and its explicit memory setting atomically", () => {
      const body = functionBody(sql, "create_project_with_memory");
      expect(body).toContain("insert into public.projects");
      expect(body).toContain("insert into public.memory_files");
      expect(body).toContain("p_memory_enabled");
      expect(body).not.toMatch(/exception[\s\S]*delete from public\.projects/i);
    });

    it("durably queues object deletion before wipe metadata is erased", () => {
      const body = functionBody(sql, "wipe_memory_file");
      const enqueue = body.indexOf("insert into public.db_jobs");
      const erase = body.indexOf("delete from public.memory_file_versions");
      expect(enqueue).toBeGreaterThanOrEqual(0);
      expect(erase).toBeGreaterThan(enqueue);
      expect(body).toContain("target.epoch + 1");
      expect(body).toContain("target.version + 1");
      expect(body).toContain("coalesce(p_enabled, target.enabled)");
      expect(body).not.toContain("generation = generation + 1");
    });

    it("registers and claims every upload before object promotion or cleanup", () => {
      const begin = functionBody(sql, "begin_memory_file_upload");
      expect(begin).toContain("insert into public.memory_object_candidates");
      expect(begin).toContain("'memory.candidate_cleanup'");
      const claim = functionBody(sql, "claim_memory_upload_candidate");
      expect(claim).toContain("where id = p_candidate_id for update");
      expect(claim).toContain("set status = 'cleaning'");
      const advance = functionBody(sql, "advance_memory_file");
      expect(advance).toContain("candidate.status <> 'uploading'");
    });

    it("cleans committed versions immediately while retaining the candidate upload grace period", () => {
      const body = functionBody(sql, "fence_memory_file_delete");
      expect(body).toContain("from public.memory_file_versions version");
      expect(body).toContain("to_jsonb(committed_paths)");
      expect(body).toContain(
        "insert into public.db_jobs(kind, payload, max_attempts, dedupe_key)",
      );
      expect(body).toContain(
        "cleanup_after = greatest(cleanup_after, candidate_cleanup_time)",
      );
      expect(body).toContain(
        "set run_at = greatest(run_at, candidate_cleanup_time)",
      );
      expect(body).not.toMatch(
        /select version\.storage_path[\s\S]*union all[\s\S]*select candidate\.storage_path/,
      );
    });

    it("uses per-turn leases and a conversation-global quiet generation for every scope", () => {
      const begin = functionBody(sql, "begin_memory_conversation_turn");
      const release = functionBody(sql, "release_memory_conversation_turn");
      const schedule = functionBody(sql, "schedule_memory_consolidation");
      expect(sql).toContain("create table if not exists public.memory_conversation_turn_leases");
      expect(begin).toContain("insert into public.memory_conversation_turn_leases");
      expect(begin).toContain("quiet_until");
      expect(release).toContain("activity_id = p_activity_id");
      expect(release).toContain("make_interval(secs => p_quiet_seconds)");
      expect(schedule).toContain("'appEpoch'");
      expect(schedule).toContain("'projectEpoch'");
      expect(schedule).toContain("'conversationGeneration'");
      expect(schedule).toContain("memory_conversation_activity");
      expect(schedule).toContain("lease.activity_id = p_activity_id");
      expect(schedule).toContain("set memory_eligible_at = terminal_at");
      expect(schedule).toContain(
        "message.content @> jsonb_build_array(jsonb_build_object(",
      );
      expect(schedule).not.toContain(
        "memory_eligible_at = terminal_at, author_user_id",
      );
      expect(schedule).toContain("next_conversation_generation := activity.generation + 1");
      expect(schedule).toContain("project_curator_actor_user_id");
      expect(schedule).toContain("order by memory_file.id");
      expect(schedule).toContain("order by pending.actor_user_id, pending.id");
    });

    it("keeps state status updates from taking file locks in reverse order", () => {
      const stateStatus = functionBody(
        sql,
        "set_memory_consolidation_status",
      );
      expect(stateStatus).not.toContain("update public.memory_files");
      const fileStatus = functionBody(sql, "refresh_memory_file_status");
      expect(fileStatus).toContain("job.status = 'pending'");
      expect(fileStatus).toContain("job.status = 'running'");
      expect(fileStatus).toContain("job.id <> p_current_job_id");
    });

    it("atomically fences curator writes and retention cleanup", () => {
      const body = functionBody(sql, "advance_memory_file");
      expect(body).toContain("memory_job_superseded");
      expect(body).toContain("consolidation.generation <> p_consolidation_generation");
      expect(body).toContain("activity.generation <> p_conversation_generation");
      expect(body).toContain("activity.quiet_until > now()");
      expect(body).toContain("memory_conversation_turn_leases");
      expect(body.indexOf("select * into activity")).toBeLessThan(
        body.indexOf("select * into consolidation"),
      );
      expect(body.indexOf("select * into consolidation")).toBeLessThan(
        body.indexOf("select * into target"),
      );
      const enqueue = body.indexOf("insert into public.db_jobs");
      const prune = body.indexOf(
        "delete from public.memory_file_versions where id = any(stale_ids)",
      );
      expect(enqueue).toBeGreaterThanOrEqual(0);
      expect(prune).toBeGreaterThan(enqueue);
    });

    it("reclaims destructive cleanup jobs indefinitely after worker crashes", () => {
      const batchClaim = functionBody(sql, "claim_db_jobs");
      const singleClaim = functionBody(sql, "claim_db_job");
      for (const body of [batchClaim, singleClaim]) {
        expect(body).toContain("'storage.cleanup'");
        expect(body).toContain("'memory.candidate_cleanup'");
        expect(body).toContain("2147483647");
        expect(body).toMatch(/status = 'failed'[\s\S]*storage\.cleanup/);
        expect(body).toMatch(/status = 'running'[\s\S]*storage\.cleanup/);
      }
      expect(batchClaim).toMatch(
        /attempts >= max_attempts[\s\S]*kind not in \('storage\.cleanup', 'memory\.candidate_cleanup'\)/,
      );
    });

    it("records direct-user attribution on every conversational message table", () => {
      expect(sql.match(/author_user_id uuid references auth\.users\(id\)/g)?.length)
        .toBeGreaterThanOrEqual(3);
      expect(sql.match(/memory_input_message_id uuid/g)?.length)
        .toBeGreaterThanOrEqual(3);
      expect(sql.match(/memory_eligible_at timestamptz/g)?.length)
        .toBeGreaterThanOrEqual(3);
    });

    it("keeps all security-definer scheduling APIs service-only", () => {
      expect(sql).toMatch(
        /revoke all on function public\.begin_memory_conversation_turn\(text, uuid, uuid, uuid, integer, integer\)[\s\S]*from public, anon, authenticated/,
      );
      expect(sql).toMatch(
        /revoke all on function public\.release_memory_conversation_turn\(text, uuid, uuid, integer\)[\s\S]*from public, anon, authenticated/,
      );
      expect(sql).toMatch(
        /revoke all on function public\.schedule_memory_consolidation\(text, uuid, uuid, uuid, uuid, uuid, integer\)[\s\S]*from public, anon, authenticated/,
      );
      expect(sql).toMatch(
        /grant execute\s+on function public\.schedule_memory_consolidation\(text, uuid, uuid, uuid, uuid, uuid, integer\)[\s\S]*to service_role/,
      );
    });
  },
);
