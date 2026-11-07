// Opt-in, disposable loopback PostgreSQL/PostgREST only. Unlike the adjacent
// unit regression, every DB query/RPC here uses the real Supabase client.
// Run this SAME test on the baseline and fixed source: it intercepts the
// actual old activation or new publication response only after it committed.
// Synthetic rows/objects are retained for inspection, not silently deleted.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import { expect, it, vi } from "vitest";
import type { DbJob } from "../../../lib/dbq/types";
import type { Db } from "../../../lib/supabase";

const { completeText } = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../../../lib/llm", async (original) => ({
  ...(await original<typeof import("../../../lib/llm")>()), completeText,
}));
vi.mock("../../../lib/providerCredentials/index", () => ({
  getUserApiKeys: async () => ({ claude: "synthetic-test-key" }),
}));
vi.mock("../../../lib/storage", async (original) => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const object = (key: string) => path.join(process.env.PLAYBOOK_NATIVE_ATTEMPT_DIR!, "objects", encodeURIComponent(key));
  return {
    ...(await original<typeof import("../../../lib/storage")>()),
    // Never let a regression send cleanup to a real object-storage account.
    deleteFile: async () => { throw new Error("Unexpected object cleanup in recovery test"); },
    deleteFileBestEffort: async () => { throw new Error("Unexpected object cleanup in recovery test"); },
    deleteFilesBestEffort: async () => { throw new Error("Unexpected object cleanup in recovery test"); },
    uploadFile: async (key: string, bytes: ArrayBuffer) => fs.writeFileSync(object(key), Buffer.from(bytes)),
    downloadFile: async (key: string) => {
      const bytes = fs.readFileSync(object(key));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
});

import { handlePlaybookReview } from "../playbooks.jobs";
import { blankPlaybookContent } from "../playbooks.operations";
import { extractDocxBodyText } from "../../../lib/docxTrackedChanges";

const enabled = process.env.PLAYBOOK_REAL_REVIEW === "1";
const phase = process.env.PLAYBOOK_NATIVE_ATTEMPT;
const testFile = "src/modules/playbooks/__tests__/playbookRecovery.supabase.test.ts";
const text = "Liability is unlimited.";
const replacement = "Liability is capped at fees paid.";
type Fixture = { user: string; document: string; original: string; book: string; run: string; path: string };

function configuration() {
  const api = new URL(process.env.SUPABASE_TEST_URL!);
  const database = new URL(process.env.SUPABASE_TEST_DB_URL!);
  for (const url of [api, database]) {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Playbook recovery tests require disposable loopback services");
  }
  if (!process.env.SUPABASE_TEST_SERVICE_ROLE_KEY || !process.env.PLAYBOOK_NATIVE_EVIDENCE_DIR)
    throw new Error("Provide the test service-role key and a task-owned evidence directory");
  return { api, database };
}

function client(): Db {
  const { api } = configuration();
  return createClient(api.href, process.env.SUPABASE_TEST_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function sql(statement: string) {
  const { database } = configuration();
  const result = spawnSync("psql", ["-XAtq", "-v", "ON_ERROR_STOP=1"], {
    input: statement, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PGHOST: database.hostname.replace(/[\[\]]/g, ""),
      PGPORT: database.port || "5432", PGDATABASE: database.pathname.slice(1),
      PGUSER: decodeURIComponent(database.username), PGPASSWORD: decodeURIComponent(database.password),
      PGCONNECT_TIMEOUT: "10", PGOPTIONS: "-c statement_timeout=20000 -c lock_timeout=10000" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "Synthetic fixture seed failed");
}

async function seed(directory: string): Promise<Fixture> {
  mkdirSync(join(directory, "objects"), { recursive: true });
  const f: Fixture = { user: randomUUID(), document: randomUUID(), original: randomUUID(),
    book: randomUUID(), run: randomUUID(), path: `test/playbook-recovery/${randomUUID()}.docx` };
  writeFileSync(join(directory, "fixture.json"), JSON.stringify(f, null, 2));
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(text)] }] }));
  writeFileSync(join(directory, "objects", encodeURIComponent(f.path)), bytes);
  const content = { ...blankPlaybookContent("Synthetic guide"), rules: [{
    id: "cap", name: "Liability cap", concept: "Require capped liability.",
  }] };
  const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const statement = `begin;
insert into auth.users(id,email) values('${f.user}','${f.user}@example.invalid');
insert into public.documents(id,user_id) values('${f.document}','${f.user}');
select public.create_document_version('${f.document}', ${literal({
    id: f.original, filename: "Synthetic.docx", storage_path: f.path,
    source: "user_upload", file_type: "docx", version_number: 1, size_bytes: bytes.length,
  })}, true);
insert into public.playbooks(id,user_id,name,content_json)
 values('${f.book}','${f.user}','Synthetic guide',${literal(content)});
insert into public.playbook_runs(id,playbook_id,user_id,content_json,document_id,document_name,model,
 review_mode,review_scope,status,findings_json,started_at,updated_at)
 values('${f.run}','${f.book}','${f.user}',${literal(content)},'${f.document}','Synthetic.docx',
 'claude-opus-5','strict','full','running','[]',now()-interval '11 minutes',now()-interval '11 minutes');
commit;`;
  writeFileSync(join(directory, "seed.sql"), statement);
  sql(statement);
  return f;
}

async function snapshot(db: Db, f: Fixture) {
  const document = await db.from("documents").select("*").eq("id", f.document).single();
  const run = await db.from("playbook_runs").select("*").eq("id", f.run).single();
  const versions = await db.from("document_versions").select("*").eq("document_id", f.document);
  const edits = await db.from("document_edits").select("*").eq("document_id", f.document);
  for (const result of [document, run, versions, edits]) if (result.error) throw result.error;
  return { document: document.data, run: run.data, versions: versions.data!, edits: edits.data! };
}

function child(directory: string, attempt: string) {
  const result = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run",
    testFile, "--pool=forks", "--maxWorkers=1", "--no-file-parallelism"], {
    encoding: "utf8", timeout: 90_000,
    env: { ...process.env, PLAYBOOK_NATIVE_ATTEMPT: attempt, PLAYBOOK_NATIVE_ATTEMPT_DIR: directory,
      DB_JOBS_ENABLED: "true", DOWNLOAD_SIGNING_SECRET: "synthetic-native-test-only", SENTRY_DSN: "" },
  });
  writeFileSync(join(directory, `${attempt}.log`), `${result.stdout}\n${result.stderr}`);
  if (result.error) throw result.error;
  return result;
}

it.skipIf(!enabled || !phase)("runs a real database review attempt", async () => {
  const directory = process.env.PLAYBOOK_NATIVE_ATTEMPT_DIR!;
  const f = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8")) as Fixture;
  const db = client();
  const prior = await snapshot(db, f);
  const rpc = db.rpc.bind(db);
  db.rpc = ((name: string, args: Record<string, unknown>) => {
    const request = rpc(name, args);
    if (phase !== "crash" || !["activate_document_version", "publish_playbook_review"].includes(name)) return request;
    return (async () => {
      const result = await request;
      if (result.error) throw result.error;
      const versionId = name === "activate_document_version" ? args.p_version_id : result.data.run.edited_version_id;
      // This is an actual DB/PostgREST acknowledgement, not a modeled RPC.
      // Kill before the review code receives it; catch/finally cannot execute.
      writeFileSync(join(directory, "committed-boundary.json"), JSON.stringify({ rpc: name, versionId }));
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    })();
  }) as unknown as Db["rpc"];
  completeText.mockResolvedValue(JSON.stringify({ summary: "Cap required", findings: [{
    ruleId: "cap", ruleName: "Liability cap", status: "unacceptable", quote: text,
    analysis: "The synthetic agreement has no cap.", suggestedText: replacement,
  }] }));
  const now = new Date().toISOString();
  const job: DbJob = {
    id: randomUUID(), kind: "playbook.review", status: "running", attempts: phase === "replay" ? 2 : 1,
    max_attempts: 3, run_at: now, claimed_at: now, finished_at: null, last_error: null,
    dedupe_key: `playbook.review:${f.run}`, result: null, created_at: now,
    payload: { runId: f.run, userId: f.user, documentText: text, instructions: null,
      userEmail: `${f.user}@example.invalid`, expectedVersion: { id: f.original, storagePath: f.path } },
  };
  await handlePlaybookReview(db, job);
  expect(completeText).toHaveBeenCalledTimes(prior.run.status === "completed" ? 0 : 1);
}, 60_000);

it.skipIf(!enabled || !!phase)("preserves real committed DOCX edits and findings across process death and reclaim", async () => {
  const db = client();
  const root = resolve(process.env.PLAYBOOK_NATIVE_EVIDENCE_DIR!);
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "review-"));
  const controlDirectory = join(directory, "control");
  const crashDirectory = join(directory, "interrupted");
  const control = await seed(controlDirectory);
  const interrupted = await seed(crashDirectory);
  expect(child(controlDirectory, "normal").status, readFileSync(join(controlDirectory, "normal.log"), "utf8")).toBe(0);
  const normal = await snapshot(db, control);
  expect(normal.run).toMatchObject({ status: "completed", edited_version_id: normal.document.current_version_id });
  expect(normal.run.findings_json[0].edit).toMatchObject({ edit_id: normal.edits[0].id });

  expect(child(crashDirectory, "crash").status).not.toBe(0);
  const boundary = JSON.parse(readFileSync(join(crashDirectory, "committed-boundary.json"), "utf8"));
  const crashed = await snapshot(db, interrupted);
  writeFileSync(join(crashDirectory, "state-at-crash.json"), JSON.stringify(crashed, null, 2));
  expect(crashed.document.current_version_id).toBe(boundary.versionId);
  expect(crashed.versions).toHaveLength(2);
  expect(crashed.edits).toHaveLength(1);
  if (boundary.rpc === "publish_playbook_review") {
    expect(crashed.run).toMatchObject({ status: "completed", edited_version_id: boundary.versionId });
    expect(crashed.run.findings_json[0].edit).toMatchObject({
      edit_id: crashed.edits[0].id, version_id: boundary.versionId,
    });
  } else {
    expect(boundary.rpc).toBe("activate_document_version");
    expect(crashed.run).toMatchObject({ status: "running", edited_version_id: null });
    expect(crashed.run.findings_json).toEqual([]);
  }
  const edited = crashed.versions.find(version => version.id === boundary.versionId)!;
  const bytes = readFileSync(join(crashDirectory, "objects", encodeURIComponent(edited.storage_path)));
  expect(await extractDocxBodyText(bytes)).toBe(replacement);
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  expect(xml).toContain("<w:del "); expect(xml).toContain("<w:ins ");
  expect(child(crashDirectory, "replay").status, readFileSync(join(crashDirectory, "replay.log"), "utf8")).toBe(0);
  const recovered = await snapshot(db, interrupted);
  writeFileSync(join(crashDirectory, "state-after-reclaim.json"), JSON.stringify(recovered, null, 2));
  expect(recovered.document.current_version_id).toBe(boundary.versionId);
  expect(recovered.versions).toHaveLength(2);
  expect(recovered.edits).toEqual(crashed.edits);
  expect(recovered.run.status).toBe("completed");
  expect.soft(recovered.run.edited_version_id).toBe(boundary.versionId);
  expect.soft(recovered.run.findings_json[0].edit).toMatchObject({
    edit_id: crashed.edits[0].id, version_id: boundary.versionId,
  });
}, 240_000);
