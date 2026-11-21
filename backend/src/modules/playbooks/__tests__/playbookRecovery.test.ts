import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import { expect, it, vi } from "vitest";

const { completeText } = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../../../lib/llm", async (original) => ({
  ...(await original<typeof import("../../../lib/llm")>()), completeText,
}));
vi.mock("../../../lib/providerCredentials/index", () => ({
  getUserApiKeys: async () => ({ claude: "synthetic-test-key" }),
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: async () => undefined }));
vi.mock("../../../lib/storage", async (original) => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const object = (key: string) => path.join(process.env.PLAYBOOK_RECOVERY_DIR!, "objects", encodeURIComponent(key));
  return {
    ...(await original<typeof import("../../../lib/storage")>()),
    uploadFile: async (key: string, bytes: ArrayBuffer) => fs.writeFileSync(object(key), Buffer.from(bytes)),
    downloadFile: async (key: string) => {
      const bytes = fs.readFileSync(object(key));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
});

import type { DbJob } from "../../../lib/dbq/types";
import { extractDocxBodyText } from "../../../lib/docxTrackedChanges";
import { blankPlaybookContent } from "../playbooks.operations";
import { handlePlaybookReview } from "../playbooks.jobs";
import { database, type Row } from "./playbookTestDb";

const TEXT = "Liability is unlimited.";
const REPLACEMENT = "Liability is capped at fees paid.";
const stage = process.env.PLAYBOOK_RECOVERY_STAGE;
const testFile = "src/modules/playbooks/__tests__/playbookRecovery.test.ts";
const stateFile = (directory: string) => join(directory, "database.json");
const readState = (directory: string): Record<string, Row[]> => JSON.parse(readFileSync(stateFile(directory), "utf8"));

/**
 * Application crash/replay contract, NOT a PostgreSQL transaction test.
 * The existing filter-aware fixture supplies DB responses; committed rows and
 * real DOCX objects survive in files when SIGKILL prevents catch/finally.
 * Neither the playbook handler, edit writer, lifecycle facade, nor DOCX engine
 * is mocked. The fake RPCs model only their documented sequential behavior.
 */
function persistentDatabase(directory: string) {
  const fixture = database([]);
  Object.assign(fixture.tables, readState(directory));
  const persist = () => writeFileSync(stateFile(directory), JSON.stringify(fixture.tables, null, 2));
  type Response = { data: Row[]; error: null };
  type FixtureQuery = {
    insert: (rows: Row[]) => { select: () => Promise<Response> };
    then: <T>(fulfilled: (value: Response) => T) => Promise<T>;
  };
  const from = fixture.db.from.bind(fixture.db) as unknown as (table: string) => FixtureQuery;
  fixture.db.from = ((table: string) => {
    const query = from(table);
    if (table === "document_edits") {
      query.insert = ((rows: Row[]) => ({
        select: async () => {
          const inserted = rows.map((row) => ({ id: randomUUID(), ...row }));
          (fixture.tables.document_edits ??= []).push(...inserted);
          persist();
          return { data: inserted, error: null };
        },
      }));
    }
    const then = query.then.bind(query);
    query.then = ((fulfilled: (value: Response) => unknown) => then((result) => {
      persist();
      return fulfilled(result);
    })) as typeof query.then;
    return query;
  }) as unknown as typeof fixture.db.from;
  const rpc = fixture.db.rpc.bind(fixture.db);
  fixture.db.rpc = (async (name: string, args: Record<string, unknown>) => {
    if (name === "publish_playbook_review") {
      const result = await rpc(name, args);
      persist();
      if (stage === "crash") {
        writeFileSync(join(directory, "crash-boundary.json"), JSON.stringify({
          rpc: name, versionId: fixture.tables.playbook_runs[0].edited_version_id, signal: "SIGKILL",
        }));
        process.kill(process.pid, "SIGKILL");
        await new Promise(() => undefined);
      }
      return result;
    }
    if (name === "create_document_version") {
      const metadata = args.p_version as Row;
      const row = {
        ...metadata, id: metadata.id ?? randomUUID(), document_id: args.p_document_id,
        version_number: fixture.tables.document_versions.length + 1,
        created_at: new Date().toISOString(), deleted_at: null,
      };
      fixture.tables.document_versions.push(row);
      if (args.p_activate) fixture.tables.documents[0].current_version_id = row.id;
      persist();
      return { data: row, error: null };
    }
    if (name === "activate_document_version") {
      fixture.tables.documents[0].current_version_id = args.p_version_id;
      persist();
      if (stage === "crash") {
        // The DB acknowledged its commit, but the process never receives the
        // result. This is an actual abrupt process death, not a caught throw.
        writeFileSync(join(directory, "crash-boundary.json"), JSON.stringify({
          rpc: name, versionId: args.p_version_id, signal: "SIGKILL",
        }));
        process.kill(process.pid, "SIGKILL");
        await new Promise(() => undefined);
      }
      return { data: true, error: null };
    }
    throw new Error(`Unexpected test RPC: ${name}`);
  }) as unknown as typeof fixture.db.rpc;
  return { ...fixture, persist };
}

async function seed(directory: string) {
  mkdirSync(join(directory, "objects"));
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(TEXT)] }] }));
  writeFileSync(join(directory, "objects", encodeURIComponent("original.docx")), bytes);
  const old = new Date(Date.now() - 11 * 60_000).toISOString();
  const content = { ...blankPlaybookContent("Synthetic guide"), rules: [{
    id: "cap", name: "Liability cap", concept: "Require capped liability.",
  }] };
  const tables = database([{
    id: "book", user_id: "owner", org_id: null, visibility: "private",
    name: "Synthetic guide", description: "", content_json: content,
    created_at: old, updated_at: old,
  }]).tables;
  tables.playbook_runs = [{
    id: "run", playbook_id: "book", user_id: "owner", model: "claude-opus-5",
    document_id: "doc", document_name: "Synthetic.docx", edited_version_id: null,
    content_json: content, review_mode: "strict", review_scope: "full",
    status: "running", summary: null, findings_json: [], error: null,
    started_at: old, updated_at: old, completed_at: null,
  }];
  tables.documents = [{ id: "doc", user_id: "owner", project_id: null, org_id: null, workflow_id: null, current_version_id: "original" }];
  tables.document_versions = [{
    id: "original", document_id: "doc", storage_path: "original.docx", source: "upload",
    filename: "Synthetic.docx", file_type: "docx", version_number: 1,
    created_at: old, deleted_at: null,
  }];
  tables.document_edits = [];
  writeFileSync(stateFile(directory), JSON.stringify(tables, null, 2));
}

function child(directory: string, phase: string) {
  const result = spawnSync(process.execPath, [
    resolve("node_modules/vitest/vitest.mjs"), "run", testFile,
    "--pool=forks", "--maxWorkers=1", "--no-file-parallelism",
  ], {
    cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PLAYBOOK_RECOVERY_DIR: directory, PLAYBOOK_RECOVERY_STAGE: phase,
      DOWNLOAD_SIGNING_SECRET: "synthetic-recovery-test-only", DB_JOBS_ENABLED: "true" },
  });
  writeFileSync(join(directory, `${phase}.log`), `${result.stdout}\n${result.stderr}`);
  if (result.error) throw result.error;
  return result;
}

it.skipIf(!stage)("runs the isolated review attempt", async () => {
  const directory = process.env.PLAYBOOK_RECOVERY_DIR!;
  const { db, tables, persist } = persistentDatabase(directory);
  const alreadyCompleted = tables.playbook_runs[0]?.status === "completed";
  completeText.mockImplementation(async () => {
    // Controlled interleavings, not proof of concurrent PostgreSQL behavior.
    // Ordinary run DELETE is already refused while active; "deleted" models
    // a parent cascade, which can remove the row while the model is pending.
    if (stage === "deleted") tables.playbook_runs = [];
    if (stage === "finished") Object.assign(tables.playbook_runs[0], {
      status: "completed", summary: "An earlier claim already completed.",
    });
    persist();
    return JSON.stringify({ summary: "Cap required", findings: [{
      ruleId: "cap", ruleName: "Liability cap", status: "unacceptable", quote: TEXT,
      analysis: "The synthetic agreement has no cap.", suggestedText: REPLACEMENT,
    }] });
  });
  const now = new Date().toISOString();
  const job: DbJob = {
    id: "job", kind: "playbook.review", status: "running", attempts: stage === "replay" ? 2 : 1,
    max_attempts: 3, run_at: now, claimed_at: now, finished_at: null, last_error: null,
    dedupe_key: "playbook.review:run", result: null, created_at: now,
    payload: { runId: "run", userId: "owner", documentText: TEXT, instructions: null,
      userEmail: null, expectedVersion: { id: "original", storagePath: "original.docx" } },
  };
  await handlePlaybookReview(db, job);
  persist();
  expect(completeText).toHaveBeenCalledTimes(alreadyCompleted ? 0 : 1);
});

it.skipIf(!!stage)("retains the exact committed edit and finding after a worker dies before saving the run", async () => {
  const retained = process.env.PLAYBOOK_RECOVERY_EVIDENCE_DIR;
  const directory = retained ? resolve(retained) : mkdtempSync(join(tmpdir(), "playbook-recovery-"));
  mkdirSync(directory, { recursive: true });
  try {
    const control = join(directory, "control");
    const interrupted = join(directory, "interrupted");
    mkdirSync(control); mkdirSync(interrupted);
    await seed(control); await seed(interrupted);
    expect(child(control, "normal").status, readFileSync(join(control, "normal.log"), "utf8")).toBe(0);
    const controlState = readState(control);
    expect(controlState.playbook_runs[0]).toMatchObject({ status: "completed", edited_version_id: controlState.documents[0].current_version_id });
    expect((controlState.playbook_runs[0].findings_json as Row[])[0].edit).toMatchObject({ edit_id: controlState.document_edits[0].id });

    expect(child(interrupted, "crash").status).not.toBe(0);
    const boundary = JSON.parse(readFileSync(join(interrupted, "crash-boundary.json"), "utf8"));
    const crashed = readState(interrupted);
    writeFileSync(join(interrupted, "database-at-crash.json"), JSON.stringify(crashed, null, 2));
    expect(crashed.playbook_runs[0]).toMatchObject(boundary.rpc === "publish_playbook_review"
      ? { status: "completed", edited_version_id: boundary.versionId }
      : { status: "running", edited_version_id: null, findings_json: [] });
    expect(crashed.documents[0].current_version_id).toBe(boundary.versionId);
    expect(crashed.document_versions).toHaveLength(2);
    expect(crashed.document_edits).toHaveLength(1);
    const version = crashed.document_versions.find((row) => row.id === boundary.versionId)!;
    const bytes = readFileSync(join(interrupted, "objects", encodeURIComponent(String(version.storage_path))));
    expect(await extractDocxBodyText(bytes)).toBe(REPLACEMENT);
    const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
    expect(xml).toContain("<w:del "); expect(xml).toContain("<w:ins ");

    expect(child(interrupted, "replay").status, readFileSync(join(interrupted, "replay.log"), "utf8")).toBe(0);
    const recovered = readState(interrupted);
    expect(recovered.document_versions).toHaveLength(2);
    expect(recovered.document_edits).toEqual(crashed.document_edits);
    expect(recovered.documents[0].current_version_id).toBe(boundary.versionId);
    expect(recovered.playbook_runs[0].status).toBe("completed");
    // These are the original regression assertions: main silently completes
    // with null and an unlinked finding despite the persisted native edits.
    expect.soft(recovered.playbook_runs[0].edited_version_id).toBe(boundary.versionId);
    expect.soft((recovered.playbook_runs[0].findings_json as Row[])[0].edit).toMatchObject({
      edit_id: crashed.document_edits[0].id, version_id: boundary.versionId,
    });
  } finally {
    if (!retained) rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

it.skipIf(!!stage).each(["deleted", "finished"])(
  "does not publish document edits when the run became %s during model work",
  async (phase) => {
    const retained = process.env.PLAYBOOK_RECOVERY_EVIDENCE_DIR;
    const directory = retained ? join(resolve(retained), phase) : mkdtempSync(join(tmpdir(), "playbook-recovery-"));
    mkdirSync(directory, { recursive: true });
    try {
      await seed(directory);
      expect(child(directory, phase).status, readFileSync(join(directory, `${phase}.log`), "utf8")).toBe(0);
      const state = readState(directory);
      if (phase === "deleted") expect(state.playbook_runs).toEqual([]);
      else expect(state.playbook_runs[0].summary).toBe("An earlier claim already completed.");
      expect.soft(state.document_versions).toHaveLength(1);
      expect.soft(state.document_edits).toHaveLength(0);
      expect.soft(state.documents[0].current_version_id).toBe("original");
    } finally {
      if (!retained) rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000,
);
