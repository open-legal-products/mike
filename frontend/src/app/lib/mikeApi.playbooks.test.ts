import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  getPlaybookConfiguration,
  importPlaybook,
  listPlaybookRuns,
  listPlaybooks,
  publishPlaybook,
  reviewDocumentWithPlaybook,
  updatePlaybook,
  type PlaybookContent,
} from "./mikeApi";

const fetchMock = vi.fn();
const id = "guide/one?draft";
const path = "/api/playbooks/guide%2Fone%3Fdraft";
const draft: PlaybookContent = {
  name: "Guide",
  description: "",
  globalGuidance: "",
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
      call: () => updatePlaybook(id, draft),
      url: path,
      method: "PUT",
      body: { draft },
    },
    {
      name: "publish",
      call: () => publishPlaybook(id),
      url: `${path}/publish`,
      method: "POST",
      body: undefined,
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
  it.each([
    { name: undefined, body: {} },
    { name: "   ", body: {} },
    { name: "  Vendor MSA  ", body: { name: "Vendor MSA" } },
  ])("posts $body for name $name", async ({ name, body }) => {
    const result = { id: "blank-guide" };
    fetchMock.mockResolvedValueOnce(json(result));

    await expect(createPlaybook(name)).resolves.toEqual(result);
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

      await expect(importPlaybook(file, "test-model", name)).resolves.toEqual(
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
    { playbookId: undefined, extra: {} },
    { playbookId: "pb-1", extra: { playbookId: "pb-1" } },
  ])("sends playbookId $playbookId when replacing", async ({ playbookId, extra }) => {
    const file = new File(["Word content"], "guide.docx");
    fetchMock
      .mockResolvedValueOnce(json(staged))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(json({ id: "pb-1" }));

    await importPlaybook(file, "test-model", undefined, playbookId);

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
  });

  it("does not compile after a storage upload fails or expose the storage response", async () => {
    fetchMock
      .mockResolvedValueOnce(json(staged))
      .mockResolvedValueOnce(
        new Response("private storage error", { status: 500 }),
      );
    await expect(
      importPlaybook(new File(["text"], "guide.docx"), "test-model"),
    ).rejects.toThrow("The playbook could not be uploaded. Please try again.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not upload when the API refuses the upload URL request", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ detail: "Playbook import currently requires a .docx file." }, 400),
    );
    await expect(
      importPlaybook(new File(["text"], "guide.txt"), "test-model"),
    ).rejects.toThrow("Playbook import currently requires a .docx file.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
