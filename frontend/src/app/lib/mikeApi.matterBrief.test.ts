import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BriefSourceIdentity } from "@mike/contracts";
import {
    applyMatterBrief,
    designateMatterBrief,
    getMatterBrief,
    getMatterBriefProposal,
    matterBriefSourceUrl,
    proposeMatterBrief,
} from "./mikeApi";

const fetchMock = vi.fn();
const project = "project/one?view#team";
const proposal = "proposal/one?view#draft";
const base = "/api/projects/project%2Fone%3Fview%23team/brief";
const documentId = "document/one?version";
const sourceIds = ["source/one?version", "source-two"];
const model = "configured/model?deployment";

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("reviewed matter brief API requests", () => {
    it.each([
        { name: "resume", call: () => getMatterBrief(project), url: base, method: "GET", body: undefined },
        { name: "designation", call: () => designateMatterBrief(project, documentId), url: `${base}/designate`, method: "POST", body: { documentId, confirmShared: true } },
        { name: "proposal generation", call: () => proposeMatterBrief(project, sourceIds, model), url: `${base}/proposals`, method: "POST", body: { sourceIds, model, confirmProvider: true } },
        { name: "proposal retrieval", call: () => getMatterBriefProposal(project, proposal), url: `${base}/proposals/proposal%2Fone%3Fview%23draft`, method: "GET", body: undefined },
        { name: "reviewed Apply", call: () => applyMatterBrief(project, proposal), url: `${base}/proposals/proposal%2Fone%3Fview%23draft/apply`, method: "POST", body: { confirmReviewed: true, confirmShared: true } },
    ])("sends $name with encoded path IDs, exact payload and session credentials", async ({ call, url, method, body }) => {
        const result = { id: "fictional-response" };
        fetchMock.mockResolvedValue(new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } }));
        await expect(call()).resolves.toEqual(result);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [actualUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(actualUrl).toBe(url);
        expect(init.method ?? "GET").toBe(method);
        expect(init.credentials).toBe("include");
        expect(init.body).toBe(body === undefined ? undefined : JSON.stringify(body));
        if (body) expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    });

    it("binds source navigation to encoded document/version and exact hash/revision parameters", () => {
        const source: BriefSourceIdentity = {
            documentId: "document/one?source",
            versionId: "version/one#current",
            hash: "hash/one?x&y=two",
            revision: "revision/one?x&y=two",
            textHash: null,
            filename: "Unsent private filename.docx",
        };
        const result = matterBriefSourceUrl(project, source);
        expect(result).toBe(`${base}/sources/document%2Fone%3Fsource/version%2Fone%23current?hash=hash%2Fone%3Fx%26y%3Dtwo&revision=revision%2Fone%3Fx%26y%3Dtwo`);
        const url = new URL(result, "https://app.example.invalid");
        expect([...url.searchParams.keys()]).toEqual(["hash", "revision"]);
        expect(url.searchParams.get("hash")).toBe(source.hash);
        expect(url.searchParams.get("revision")).toBe(source.revision);
        expect(result).not.toContain(source.filename);
        expect(result).not.toContain("textHash");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
