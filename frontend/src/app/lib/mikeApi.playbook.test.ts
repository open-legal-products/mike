import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MikeApiError, createPlaybookRule, listPlaybookRules, updatePlaybookRule } from "./mikeApi";

const fetchMock = vi.fn();
const jsonResponse = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
const lastFetchCall = () => {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return { url: call[0] as string, init: call[1] as RequestInit };
};

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
});

const RULE = { id: "r1", rule_number: "RULE 1", title: "Cap", description: "d", thresholds: {}, severity: "HIGH", is_active: true, created_at: "2026-09-21T00:00:00Z", updated_at: null };

describe("playbook api", () => {
    it("lists rules", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([RULE]));
        expect(await listPlaybookRules()).toEqual([RULE]);
        const { url, init } = lastFetchCall();
        expect(url).toMatch(/\/playbook$/);
        expect(init.method ?? "GET").toBe("GET");
    });

    it("creates a rule with a JSON body", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(RULE, { status: 201 }));
        const input = { rule_number: "RULE 1", title: "Cap", description: "d", thresholds: { max: 10 }, severity: "HIGH" as const };
        expect(await createPlaybookRule(input)).toEqual(RULE);
        const { url, init } = lastFetchCall();
        expect(url).toMatch(/\/playbook$/);
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual(input);
    });

    it("patches a rule by id and surfaces API errors", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ...RULE, is_active: false }));
        expect(await updatePlaybookRule("r 1", { is_active: false })).toMatchObject({ is_active: false });
        const { url, init } = lastFetchCall();
        expect(url).toMatch(/\/playbook\/r%201$/);
        expect(init.method).toBe("PATCH");
        expect(JSON.parse(init.body as string)).toEqual({ is_active: false });

        fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Hanya administrator" }, { status: 403 }));
        await expect(updatePlaybookRule("r1", { title: "x" })).rejects.toBeInstanceOf(MikeApiError);
    });
});
