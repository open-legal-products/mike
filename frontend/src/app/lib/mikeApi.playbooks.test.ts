import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  getPlaybookConfiguration,
  getPlaybookPeople,
  listPlaybookShares,
  sharePlaybook,
  revokePlaybookShare,
  getPlaybookSourceUrl,
  getPlaybookSupplementaryFileUrl,
  listPlaybookSources,
  uploadPlaybookSource,
  addPlaybookSourceFromDocument,
  deletePlaybookSource,
  startPlaybookImport,
  listPlaybookRuns,
  listAllPlaybookRuns,
  listPlaybooks,
  reviewDocumentWithPlaybook,
  updatePlaybook,
  type PlaybookContent,
} from "./mikeApi";

const fetchMock = vi.fn();
const id = "guide/one?view";
const path = "/api/playbooks/guide%2Fone%3Fview";
const content: PlaybookContent = {
  name: "Guide",
  description: "",
  representedParty: "",
  documentTypes: [],
  jurisdictions: [],
  topics: [],
};
const review = {
  documentText: "Contract text",
  documentName: "contract.txt",
  instructions: "Check liability",
  model: "test-model",
  reviewMode: "strict" as const,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Playbooks API requests", () => {
  it.each([
    {
      name: "configuration",
      call: getPlaybookConfiguration,
      url: "/api/playbooks/configuration",
      method: "GET",
      body: undefined,
    },
    {
      name: "workspace configuration",
      call: () => getPlaybookConfiguration("org/a?b"),
      url: "/api/playbooks/configuration?workspace=org%2Fa%3Fb",
      method: "GET",
      body: undefined,
    },
    {
      name: "list",
      call: listPlaybooks,
      url: "/api/playbooks",
      method: "GET",
      body: undefined,
    },
    {
      name: "get",
      call: () => getPlaybook(id),
      url: path,
      method: "GET",
      body: undefined,
    },
    {
      name: "update",
      call: () => updatePlaybook(id, content),
      url: path,
      method: "PUT",
      body: { content },
    },
    {
      name: "workspace list",
      call: () => listPlaybooks("personal"),
      url: "/api/playbooks?workspace=personal",
      method: "GET",
      body: undefined,
    },
    {
      name: "runs across playbooks",
      call: () => listAllPlaybookRuns("personal"),
      url: "/api/playbooks/runs?workspace=personal",
      method: "GET",
      body: undefined,
    },
    {
      name: "all runs without a workspace filter",
      call: () => listAllPlaybookRuns(),
      url: "/api/playbooks/runs",
      method: "GET",
      body: undefined,
    },
    {
      name: "people",
      call: () => getPlaybookPeople(id),
      url: `${path}/people`,
      method: "GET",
      body: undefined,
    },
    {
      name: "shares",
      call: () => listPlaybookShares(id),
      url: `${path}/shares`,
      method: "GET",
      body: undefined,
    },
    {
      name: "share with an editor",
      call: () => sharePlaybook(id, { emails: ["editor@example.com"], role: "editor" }),
      url: `${path}/share`,
      method: "POST",
      body: { emails: ["editor@example.com"], role: "editor" },
    },
    {
      name: "revoke share",
      call: () => revokePlaybookShare(id, "share/one?two"),
      url: `${path}/shares/share%2Fone%3Ftwo`,
      method: "DELETE",
      body: undefined,
    },
    {
      name: "access update",
      call: () => updatePlaybook(id, content, { visibility: "private" }),
      url: path,
      method: "PUT",
      body: {
        content,
        visibility: "private",
      },
    },
    {
      name: "review",
      call: () => reviewDocumentWithPlaybook(id, review),
      url: `${path}/review`,
      method: "POST",
      body: review,
    },
    {
      name: "runs",
      call: () => listPlaybookRuns(id),
      url: `${path}/runs`,
      method: "GET",
      body: undefined,
    },
  ])(
    "sends the $name request with session credentials and an encoded ID",
    async ({ call, url, method, body }) => {
      const result = { id: "response-id" };
      fetchMock.mockResolvedValue(json(result));
      await expect(call()).resolves.toEqual(result);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [actualUrl, init] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(actualUrl).toBe(url);
      expect(init.method ?? "GET").toBe(method);
      expect(init.credentials).toBe("include");
      expect(init.body).toBe(
        body === undefined ? undefined : JSON.stringify(body),
      );
      if (body)
        expect(init.headers).toMatchObject({
          "Content-Type": "application/json",
        });
    },
  );

  it("points the source viewer at the playbook's own source route", () => {
    expect(getPlaybookSourceUrl(id)).toBe(`${path}/source`);
  });

  it("deletes the selected playbook and accepts an empty response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(deletePlaybook(id)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    );
  });
});

describe("Creating a playbook with no Word source", () => {
  it("creates in the selected workspace, with its access", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "org-guide" }));
    await createPlaybook(
      { name: "  Guide  ", visibility: "organization" },
      "org-1",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: "Guide", visibility: "organization", workspace: "org-1",
    });
  });

  it.each([
    { details: undefined, body: {} },
    { details: { name: "   " }, body: {} },
    { details: { name: "  Vendor MSA  " }, body: { name: "Vendor MSA" } },
    {
      details: {
        name: "NDA",
        representedParty: "Recipient",
        documentTypes: ["NDA"],
        jurisdictions: ["England and Wales"],
      },
      body: {
        name: "NDA",
        representedParty: "Recipient",
        documentTypes: ["NDA"],
        jurisdictions: ["England and Wales"],
      },
    },
  ])("posts $body for $details", async ({ details, body }) => {
    const result = { id: "blank-guide" };
    fetchMock.mockResolvedValueOnce(json(result));

    await expect(createPlaybook(details)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/playbooks",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify(body),
      }),
    );
  });
});

describe("Playbook direct upload", () => {
  const staged = {
    uploadUrl: "https://storage.example/signed-upload",
    storageKey: "playbooks/u1/imports/source.docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };

  it.each([undefined, "   ", "  Company guide  "])(
    "uploads before compilation with name %s",
    async (name) => {
      const file = new File(["Word content"], "guide.docx");
      const result = { id: "imported-guide" };
      fetchMock
        .mockResolvedValueOnce(json(staged))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(json(result));

      await expect(startPlaybookImport(file, "test-model", name)).resolves.toEqual(
        result,
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "/api/playbooks/import/upload-url",
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          body: JSON.stringify({
            filename: "guide.docx",
            sizeBytes: file.size,
          }),
        }),
      );
      // Only the signed URL authorizes the storage request. Session credentials stay on the API requests.
      expect(fetchMock).toHaveBeenNthCalledWith(2, staged.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": staged.contentType },
        body: file,
      });
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        "/api/playbooks/import",
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          body: JSON.stringify({
            storageKey: staged.storageKey,
            filename: "guide.docx",
            model: "test-model",
            ...(name?.trim() ? { name: "Company guide" } : {}),
          }),
        }),
      );
    },
  );

  it.each([
    { playbookId: undefined, workspace: undefined, extra: {} },
    { playbookId: "pb-1", workspace: undefined, extra: { playbookId: "pb-1" } },
    { playbookId: undefined, workspace: "org-1", extra: { workspace: "org-1" } },
  ])(
    "sends playbookId $playbookId when replacing",
    async ({ playbookId, workspace, extra }) => {
      const file = new File(["Word content"], "guide.docx");
      fetchMock
        .mockResolvedValueOnce(json(staged))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(json({ id: "pb-1" }));

      await startPlaybookImport(file, "test-model", undefined, playbookId, workspace);

      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        "/api/playbooks/import",
        expect.objectContaining({
          body: JSON.stringify({
            storageKey: staged.storageKey,
            filename: "guide.docx",
            model: "test-model",
            ...extra,
          }),
        }),
      );
    },
  );

  it("does not compile after a storage upload fails or expose the storage response", async () => {
    fetchMock
      .mockResolvedValueOnce(json(staged))
      .mockResolvedValueOnce(
        new Response("private storage error", { status: 500 }),
      );
    await expect(
      startPlaybookImport(new File(["text"], "guide.docx"), "test-model"),
    ).rejects.toThrow("The playbook could not be uploaded. Please try again.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("compiles a saved document without staging an upload", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "pb-1" }, 201));
    await expect(
      startPlaybookImport({ documentId: "doc-1" }, "test-model", " Standards "),
    ).resolves.toEqual({ id: "pb-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/playbooks\/import$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      documentId: "doc-1",
      model: "test-model",
      name: "Standards",
    });
  });

  it("does not upload when the API refuses the upload URL request", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ detail: "Playbook import requires a .docx or .pdf file." }, 400),
    );
    await expect(
      startPlaybookImport(new File(["text"], "guide.txt"), "test-model"),
    ).rejects.toThrow("Playbook import requires a .docx or .pdf file.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Playbook supplementary documents", () => {
  const source = {
    id: "s/1",
    filename: "Policy.pdf",
    fileType: "pdf",
    sizeBytes: 4,
    createdAt: "2026-10-17T00:00:00.000Z",
  };

  it("lists, adds from a document, and removes through the playbook's own routes", async () => {
    fetchMock
      .mockResolvedValueOnce(json([source]))
      .mockResolvedValueOnce(json(source, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(listPlaybookSources(id)).resolves.toEqual([source]);
    await addPlaybookSourceFromDocument(id, "doc-1");
    await deletePlaybookSource(id, "s/1");

    expect(
      fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"]),
    ).toEqual([
      [`${path}/sources`, "GET"],
      [`${path}/sources`, "POST"],
      [`${path}/sources/s%2F1`, "DELETE"],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      documentId: "doc-1",
    });
    expect(getPlaybookSupplementaryFileUrl(id, "s/1")).toBe(
      `${path}/sources/s%2F1/file`,
    );
  });

  it("stages an upload, puts the bytes to storage, then adds the staged file", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(
          {
            uploadUrl: "https://storage.example/put",
            storageKey: "playbooks/u1/source-uploads/k.pdf",
            contentType: "application/pdf",
          },
          201,
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(json(source, 201));
    const file = new File(["%PDF"], "Policy.pdf", { type: "application/pdf" });

    await expect(uploadPlaybookSource(id, file)).resolves.toEqual(source);

    expect(fetchMock.mock.calls[0][0]).toBe(`${path}/sources/upload-url`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      filename: "Policy.pdf",
      sizeBytes: 4,
    });
    expect(fetchMock.mock.calls[1]).toEqual([
      "https://storage.example/put",
      expect.objectContaining({ method: "PUT", body: file }),
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      storageKey: "playbooks/u1/source-uploads/k.pdf",
      filename: "Policy.pdf",
    });
  });

  it("does not add anything when the storage upload fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(
          {
            uploadUrl: "https://storage.example/put",
            storageKey: "k",
            contentType: "application/pdf",
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        new Response("denied by bucket policy", { status: 403 }),
      );

    await expect(
      uploadPlaybookSource(id, new File(["x"], "Policy.pdf")),
    ).rejects.toThrow("The document could not be uploaded");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
