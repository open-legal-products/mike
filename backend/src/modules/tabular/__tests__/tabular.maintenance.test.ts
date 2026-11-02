// The stale-cell sweep's own queries. supabase-js resolves a refused
// statement as a plain object; logged raw, it reached Sentry with no stack
// and no code. The sweep now reports it under `db.query_failed` with that
// object as the cause (its SQLSTATE arrives as failure_code), and still
// answers the way it did: nothing swept, nothing thrown.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../tabular.service", () => ({
    finalizeCell: vi.fn(),
    finishGenerationIfIdle: vi.fn(),
}));
vi.mock("../../../lib/queue/extractionQueue", () => ({
    getExtractionQueue: vi.fn(),
    extractionJobId: vi.fn(),
}));
vi.mock("../../../lib/queue/connection", () => ({
    withRedisTimeout: vi.fn(),
}));
vi.mock("../../../lib/dbq/driver", () => ({ redisEnabled: () => false }));
vi.mock("../../../lib/dbq/enqueue", () => ({ liveDbJobExists: vi.fn() }));
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
const reportError = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("../../../lib/observability/sentry")
    >()),
    reportError,
}));

import { AppError } from "../../../lib/appError";
import { diagnosticErrorTags } from "../../../lib/observability/sentryPrivacy";
import { sweepStaleGeneratingCells } from "../tabular.maintenance";
import { makeFakeDb } from "./fakeDb";

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    vi.clearAllMocks();
    process.env.ASYNC_TABULAR_EXTRACTION = "true";
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
    delete process.env.ASYNC_TABULAR_EXTRACTION;
    consoleError.mockRestore();
});

describe("sweepStaleGeneratingCells", () => {
    it("reports a refused cells query under its kind with the SQLSTATE, and sweeps nothing", async () => {
        const refused = { code: "57014", message: "canceling statement" };
        const fake = makeFakeDb({
            tables: { tabular_cells: { data: null, error: refused } },
        });

        await expect(sweepStaleGeneratingCells(fake.db)).resolves.toBe(0);

        expect(reportError).toHaveBeenCalledTimes(1);
        const [reported, context] = reportError.mock.calls[0];
        expect(reported).toBeInstanceOf(AppError);
        expect(reported.kind).toBe("db.query_failed");
        expect(reported.cause).toBe(refused);
        expect(context).toEqual({ tags: { component: "stale-sweep" } });
        expect(diagnosticErrorTags(reported)).toEqual({
            error_kind: "db.query_failed",
            failure_code: "57014",
        });
        expect(consoleError).toHaveBeenCalledWith(
            "[stale-sweep] cells query failed",
            reported,
        );
    });

    it("reports nothing when there is nothing to sweep", async () => {
        const fake = makeFakeDb({
            tables: { tabular_cells: { data: [], error: null } },
        });
        await expect(sweepStaleGeneratingCells(fake.db)).resolves.toBe(0);
        expect(reportError).not.toHaveBeenCalled();
    });
});
