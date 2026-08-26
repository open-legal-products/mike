import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  prepareWorkflowCatalog,
  removePreparedWorkflowCatalog,
  validateWorkflowCatalogDocument,
} from "../workflowCatalogSource";

const COMMIT = "a".repeat(40);

function skill(options: {
  key: string;
  title: string;
  type: "assistant" | "tabular";
}) {
  return `---
name: "${options.key}"
description: "Test workflow"
license: "MIT"
metadata:
  version: "1.0.0"
  author: "Open Legal Products"
  language: "English"
  mike-display-name: "${options.title}"
  mike-type: "${options.type}"
  mike-availability: "system"
  practice: "General Transactions"
  jurisdictions: "General"
---
Run the test workflow.
`;
}

async function archive(options: { duplicate?: boolean } = {}) {
  const zip = new JSZip();
  const root = "mike-workflows-test/";
  for (const [key, title] of [
    ["compare-documents", "Compare Documents"],
    ["extract-key-terms", "Extract Key Terms"],
    ["draft-from-template", "Draft From Template"],
  ] as const) {
    zip.file(
      `${root}assistant-workflows/${key}/SKILL.md`,
      skill({ key, title, type: "assistant" }),
    );
  }
  zip.file(
    `${root}assistant-workflows/proofread/SKILL.md`,
    skill({ key: "proofread", title: "Proofread", type: "assistant" }),
  );
  zip.file(
    `${root}assistant-workflows/proofread/assets/template.docx`,
    Buffer.from("test template"),
  );
  const requiredTabular = "commercial-agreement-tabular-review";
  zip.file(
    `${root}tabular-review-workflows/${requiredTabular}/SKILL.md`,
    skill({
      key: requiredTabular,
      title: "Commercial Agreement Review",
      type: "tabular",
    }),
  );
  zip.file(
    `${root}tabular-review-workflows/${requiredTabular}/table-columns.yaml`,
    `columns:
  - index: 0
    name: "Issue"
    prompt: "Identify the issue"
`,
  );
  zip.file(
    `${root}tabular-review-workflows/${options.duplicate ? "proofread" : "test-table"}/SKILL.md`,
    skill({
      key: options.duplicate ? "proofread" : "test-table",
      title: "Test Table",
      type: "tabular",
    }),
  );
  zip.file(
    `${root}tabular-review-workflows/${options.duplicate ? "proofread" : "test-table"}/table-columns.yaml`,
    `columns:
  - index: 0
    name: "Issue"
    prompt: "Identify the issue"
`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

function githubFetch(zipBytes: Buffer) {
  return vi.fn(async (url: string | URL | Request) => {
    const value =
      url instanceof Request ? url.url : url instanceof URL ? url.href : url;
    if (new URL(value).hostname === "api.github.com") {
      return new Response(JSON.stringify({ sha: COMMIT }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // BodyInit wants an ArrayBuffer-backed view; Node's Buffer is typed over
    // ArrayBufferLike (it may sit on a SharedArrayBuffer), so hand Response a
    // plain Uint8Array over the same bytes.
    return new Response(new Uint8Array(zipBytes), {
      status: 200,
      headers: { "content-length": String(zipBytes.byteLength) },
    });
  }) as typeof fetch;
}

describe("GitHub workflow catalog preparation", () => {
  it("creates a validated temporary catalog and extracts assets", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "catalog-source-test-"),
    );
    try {
      const prepared = await prepareWorkflowCatalog({
        temporaryRoot,
        fetchImpl: githubFetch(await archive()),
      });
      const document = validateWorkflowCatalogDocument(
        JSON.parse(await readFile(prepared.catalogPath, "utf8")) as unknown,
      );
      expect(document.source_commit).toBe(COMMIT);
      expect(document.workflows).toHaveLength(6);
      expect(
        document.workflows.find(
          (workflow) => workflow.workflow_key === "proofread",
        ),
      ).toMatchObject({
        distribution: "default",
        default_sort_order: 0,
        quick_action_name: "Proofread",
      });
      const reference = document.workflows.find(
        (workflow) => workflow.workflow_key === "proofread",
      )!.reference_files[0];
      expect(reference).toMatchObject({
        filename: "template.docx",
        file_type: "docx",
        size_bytes: 13,
      });
      await expect(readFile(reference.temporary_path, "utf8")).resolves.toBe(
        "test template",
      );

      await removePreparedWorkflowCatalog(prepared);
      await expect(readFile(prepared.catalogPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects duplicate workflow keys and cleans its temporary directory", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "catalog-source-test-"),
    );
    try {
      await expect(
        prepareWorkflowCatalog({
          temporaryRoot,
          fetchImpl: githubFetch(await archive({ duplicate: true })),
        }),
      ).rejects.toThrow("duplicate key 'proofread'");
      await expect(readdir(temporaryRoot)).resolves.toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects oversized downloads before parsing and cleans up", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value =
        url instanceof Request ? url.url : url instanceof URL ? url.href : url;
      if (new URL(value).hostname === "api.github.com") {
        return new Response(JSON.stringify({ sha: COMMIT }), { status: 200 });
      }
      return new Response("oversized", {
        status: 200,
        headers: { "content-length": String(11 * 1024 * 1024) },
      });
    }) as typeof fetch;
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "catalog-source-test-"),
    );
    try {
      await expect(
        prepareWorkflowCatalog({ temporaryRoot, fetchImpl }),
      ).rejects.toThrow("10 MB compressed limit");
      await expect(readdir(temporaryRoot)).resolves.toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
