// Unit tests for `claimTabularGeneration` — the atomic gate the generate
// stream passes through between its pre-lease guards and its post-lease work
// snapshot. Each answer the RPC can give maps to one response, and the wording
// here is deliberately NOT the wording the mutating endpoints use ("already
// running elsewhere" vs "currently running"), so the strings are asserted.

import { describe, it, expect } from "vitest";

import { claimTabularGeneration } from "../tabular.generate";
import { makeFakeDb } from "./fakeDb";

const ARGS = {
    reviewId: "rev-1",
    expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    generationId: "gen-1",
};

const claimWith = (result: { data: unknown; error: unknown }) =>
    claimTabularGeneration(makeFakeDb({ rpc: () => result }).db, ARGS);

describe("claimTabularGeneration", () => {
    it("passes the caller's expected_updated_at to the RPC", async () => {
        const fake = makeFakeDb({ rpc: () => ({ data: "started", error: null }) });
        const result = await claimTabularGeneration(fake.db, ARGS);
        expect(result).toEqual({ ok: true, data: null });
        expect(fake.rpcCalls[0]).toMatchObject({
            fn: "begin_tabular_review_generation",
            args: {
                target_review_id: "rev-1",
                expected_updated_at: "2026-01-01T00:00:00.000Z",
                target_generation_id: "gen-1",
            },
        });
    });

    it("409s a run already in flight elsewhere", async () => {
        const result = await claimWith({ data: "running", error: null });
        expect(result).toMatchObject({
            ok: false,
            kind: "conflict",
            code: "review_running",
            detail: "This tabular review is already running elsewhere.",
        });
    });

    it("409s a stale expected_updated_at", async () => {
        const result = await claimWith({ data: "stale", error: null });
        expect(result).toMatchObject({
            ok: false,
            kind: "conflict",
            code: "review_stale",
            detail: "A newer version of this tabular review is available.",
        });
    });

    it("404s a review the RPC cannot find", async () => {
        const result = await claimWith({ data: "not_found", error: null });
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Review not found",
        });
    });

    it("500s an unrecognized answer with its own wording", async () => {
        const result = await claimWith({ data: "wat", error: null });
        expect(result).toMatchObject({
            ok: false,
            kind: "status",
            status: 500,
            body: { detail: "Failed to start tabular review generation" },
        });
    });

    it("reports an RPC error as an internal failure", async () => {
        const result = await claimWith({ data: null, error: { m: "boom" } });
        expect(result).toMatchObject({ ok: false, kind: "error" });
    });
});
