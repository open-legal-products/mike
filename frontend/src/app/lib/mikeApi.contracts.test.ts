import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MikeApiError,
    createReview,
    deleteContract,
    getContract,
    getContractDownloadUrl,
    getContractFileUrl,
    getMe,
    projectContractRedline,
    resolveContractRevision,
    getReviewStatus,
    listContracts,
    patchContract,
    postContractComment,
    postContractFeedback,
    postContractFeedbackBulk,
    postContractMissedClause,
    saveContractClause,
    uploadContractFile,
} from "./mikeApi";

const fetchMock = vi.fn();

const jsonResponse = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        ...init,
    });

const lastFetchCall = () => {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return { url: call[0] as string, init: call[1] as RequestInit };
};

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("contracts API wrappers", () => {
    it("getMe reads the caller identity from the contracts module", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ userId: "u1", email: "a@b.co", isAdmin: true }),
        );

        const me = await getMe();

        expect(me).toEqual({ userId: "u1", email: "a@b.co", isAdmin: true });
        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/contracts/me");
        expect(init.credentials).toBe("include");
    });

    it("getContract loads the full review with feedback and comments", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ review: { id: "r 1" }, feedback: [], comments: [] }),
        );

        const detail = await getContract("r 1");

        expect(detail.review.id).toBe("r 1");
        expect(lastFetchCall().url).toBe("/api/contracts/r%201");
    });

    it("getContractFileUrl points at the gateway stream", () => {
        expect(getContractFileUrl("r 1")).toBe("/api/contracts/r%201/file");
    });

    it("listContracts hits the team-wide list", async () => {
        fetchMock.mockResolvedValue(jsonResponse([{ id: "r1" }]));

        const rows = await listContracts();

        expect(rows).toEqual([{ id: "r1" }]);
        expect(lastFetchCall().url).toBe("/api/contracts");
    });

    it("deleteContract issues DELETE with an encoded id and accepts 204", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        await expect(deleteContract("a b/c")).resolves.toBeUndefined();

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/contracts/a%20b%2Fc");
        expect(init.method).toBe("DELETE");
    });

    it("uploadContractFile posts the raw bytes with the filename in the query", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                contract_text: "text",
                contract_html: "<p>text</p>",
                filename: "PKS A&B.docx",
            }),
        );
        const file = new File(["PK"], "PKS A&B.docx", {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });

        const extracted = await uploadContractFile(file);

        expect(extracted.filename).toBe("PKS A&B.docx");
        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/contracts/upload?filename=PKS%20A%26B.docx");
        expect(init.method).toBe("POST");
        expect(init.body).toBe(file);
        expect(init.headers).toMatchObject({
            "Content-Type": "application/octet-stream",
            Accept: "application/json",
        });
        expect(
            (init.headers as Record<string, string>).Authorization,
        ).toBeUndefined();
    });

    it("uploadContractFile surfaces the backend detail on failure", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(
                { detail: "Hanya file DOCX yang diperbolehkan." },
                { status: 400 },
            ),
        );

        await expect(
            uploadContractFile(new File(["x"], "c.pdf")),
        ).rejects.toMatchObject({
            name: "MikeApiError",
            status: 400,
            message: "Hanya file DOCX yang diperbolehkan.",
        } satisfies Partial<MikeApiError>);
    });

    it("createReview posts the JSON body and returns the processing handle", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ id: "r9", status: "processing" }, { status: 201 }),
        );
        const input = {
            client_name: "PT A",
            document_type: "PKS",
            review_focus: ["payment"],
            contract_text: "body",
            contract_html: null,
            contract_filename: "a.docx",
        };

        const created = await createReview(input);

        expect(created).toEqual({ id: "r9", status: "processing" });
        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/contracts");
        expect(init.method).toBe("POST");
        expect(init.headers).toMatchObject({
            "Content-Type": "application/json",
        });
        expect(JSON.parse(init.body as string)).toEqual(input);
    });

    it("getReviewStatus polls the encoded status route", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                id: "r9",
                status: "ai_reviewed",
                risk_level: "HIGH",
                recommendation: "NEEDS_REVISIONS",
            }),
        );

        const status = await getReviewStatus("r9");

        expect(status.status).toBe("ai_reviewed");
        expect(lastFetchCall().url).toBe("/api/contracts/r9/status");
    });

    it("postContractFeedback posts one Janus-shaped row", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ id: "f1" }, { status: 201 }));
        const input = { finding_type: "red_flag", finding_id: "RF-001", action: "valid", original_severity: "HIGH" };

        const row = await postContractFeedback("r1", input);

        expect(row).toEqual({ id: "f1" });
        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/contracts/r1/feedback");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual(input);
    });

    it("postContractFeedbackBulk wraps the items", async () => {
        fetchMock.mockResolvedValue(jsonResponse([], { status: 201 }));

        await postContractFeedbackBulk("r1", [{ finding_type: "revision", finding_id: "REV-001", action: "accept" }]);

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/contracts/r1/feedback/bulk");
        expect(JSON.parse(init.body as string)).toEqual({ items: [{ finding_type: "revision", finding_id: "REV-001", action: "accept" }] });
    });

    it("postContractComment and postContractMissedClause hit their routes", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ id: "c1" }, { status: 201 }));
        await postContractComment("r1", { comment_type: "note", comment_text: "x" });
        expect(lastFetchCall().url).toBe("/api/contracts/r1/comments");

        fetchMock.mockResolvedValue(jsonResponse({ id: "m1" }, { status: 201 }));
        await postContractMissedClause("r1", { highlight_text: "t", suggested_category: "red_flag", user_note: "n" });
        expect(lastFetchCall().url).toBe("/api/contracts/r1/missed-clause");
    });

    it("saveContractClause and patchContract send their bodies", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ id: "cl1" }, { status: 201 }));
        await saveContractClause("r1", { title: "t", wording: "w" });
        let call = lastFetchCall();
        expect(call.url).toBe("/api/contracts/r1/clauses");
        expect(JSON.parse(call.init.body as string)).toEqual({ title: "t", wording: "w" });

        fetchMock.mockResolvedValue(jsonResponse({ id: "r1", status: "clevel_reviewed" }));
        const patched = await patchContract("r1", { status: "clevel_reviewed" });
        expect(patched.status).toBe("clevel_reviewed");
        call = lastFetchCall();
        expect(call.url).toBe("/api/contracts/r1");
        expect(call.init.method).toBe("PATCH");
    });

    it("redline projection and revision resolution hit their routes", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ projected: 1, failed: 0, skipped: 0, edits: [] }));
        await projectContractRedline("r1");
        let call = lastFetchCall();
        expect(call.url).toBe("/api/contracts/r1/redline/project");
        expect(call.init.method).toBe("POST");

        fetchMock.mockImplementation(async () => jsonResponse({ edit: { id: "e1" }, feedback: { id: "f1" } }));
        await resolveContractRevision("r1", "REV-001", "reject", { rationale: "x" });
        call = lastFetchCall();
        expect(call.url).toBe("/api/contracts/r1/revisions/REV-001/reject");
        expect(JSON.parse(call.init.body as string)).toEqual({ rationale: "x" });

        await resolveContractRevision("r1", "REV-001", "accept");
        expect(JSON.parse(lastFetchCall().init.body as string)).toEqual({});
    });

    it("getContractDownloadUrl requests an attachment, optionally the original", () => {
        expect(getContractDownloadUrl("r1")).toBe("/api/contracts/r1/file?download=1");
        expect(getContractDownloadUrl("r1", "original")).toBe("/api/contracts/r1/file?download=1&variant=original");
    });
});
