import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MikeApiError,
    createReview,
    deleteContract,
    getMe,
    getReviewStatus,
    listContracts,
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
});
