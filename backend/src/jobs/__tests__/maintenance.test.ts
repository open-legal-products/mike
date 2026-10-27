import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import type { Db } from "../../lib/supabase";
import { markStage, resetSentryForTests, scrubEvent, setOperation } from "../../lib/observability/sentry";
import { privacyBoundaryIntegration } from "../../lib/observability/sentryPrivacy";

const sweeps = vi.hoisted(() => ({
    text: vi.fn(), documents: vi.fn(), cells: vi.fn(), organizations: vi.fn(), subagents: vi.fn(),
    captureCleanup: vi.fn(), completeCleanup: vi.fn(),
}));
vi.mock("../../modules/documents/documents.service", () => ({
    backfillDocumentText: sweeps.text,
    sweepStaleProcessingDocuments: sweeps.documents,
    captureInlineDocumentCleanup: sweeps.captureCleanup,
    completeInlineDocumentCleanup: sweeps.completeCleanup,
}));
vi.mock("../../modules/tabular/tabular.service", () => ({ sweepStaleGeneratingCells: sweeps.cells }));
vi.mock("../../modules/chat/chat.service", () => ({ purgeExpiredSubagentRuns: sweeps.subagents }));
vi.mock("../../modules/orgs/orgs.service", async () => ({
    // Exercise the real archive service through the timer's reporting boundary.
    expireDepartureArchives: (await vi.importActual<typeof import("../../modules/orgs/orgs.retention")>("../../modules/orgs/orgs.retention")).expireDepartureArchives,
    purgeExpiredOrganizations: sweeps.organizations,
}));
import { runStaleWorkSweep } from "../maintenance";

const PRIVATE = "SYNTHETIC_CLIENT_Jane_Doe_NDA.pdf jane@example.test";
function database(failureAt?: "load" | "expire") {
    const cause = { code: "42501", message: PRIVATE, details: PRIVATE, hint: PRIVATE };
    const query: Record<string, unknown> = {};
    for (const method of ["select", "lte", "order", "limit"]) query[method] = () => query;
    query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: failureAt === "load" ? cause : null }).then(resolve);
    return {
        from: vi.fn(() => query),
        rpc: vi.fn(async () => ({ data: 1, error: failureAt === "expire" ? cause : null })),
    };
}

let warnings: unknown[][];
beforeEach(() => {
    vi.resetAllMocks();
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args); });
    sweeps.captureCleanup.mockResolvedValue([]);
});
afterEach(async () => {
    await Sentry.close();
    resetSentryForTests("community");
    vi.restoreAllMocks();
});

it.each([
    ["community", "load"], ["community", "expire"],
    ["official", "load"], ["official", "expire"],
] as const)("reports all sweeps once and preserves archive %s/%s diagnostics without private data", async (install, failureAt) => {
    const events: Sentry.ErrorEvent[] = [];
    resetSentryForTests(install, { initialized: true });
    Sentry.init({
        dsn: "https://test@sentry.invalid/1", defaultIntegrations: false,
        integrations: [privacyBoundaryIntegration(), Sentry.captureConsoleIntegration({ levels: ["error"] })],
        beforeSend: scrubEvent,
        transport: () => ({
            send: async envelope => {
                for (const [header, payload] of envelope[1]) {
                    if (header.type === "event") events.push(payload as Sentry.ErrorEvent);
                }
                return { statusCode: 200 };
            },
            flush: async () => true,
        }),
    });
    setOperation("outside.sweep");
    const cause = { code: "ECONNRESET", message: PRIVATE };
    for (const sweep of [sweeps.text, sweeps.cells, sweeps.organizations, sweeps.subagents]) sweep.mockRejectedValue(cause);
    sweeps.documents.mockImplementation(async () => {
        markStage("documents-only");
        await Promise.resolve();
        throw new Error(PRIVATE, { cause });
    });
    const db = database(failureAt);
    await expect(runStaleWorkSweep(db as unknown as Db)).resolves.toEqual({ documents: 0, cells: 0 });
    await Sentry.flush(2000);

    expect(events).toHaveLength(6);
    expect(events.map(event => event.tags?.operation)).toEqual([
        "maintenance.document_text", "maintenance.documents", "maintenance.cells",
        "maintenance.organization_archives", "maintenance.organizations", "maintenance.subagent_runs",
    ]);
    for (const event of events) {
        expect(event.tags?.component).toBe("stale-sweep");
        const archive = event.tags?.operation === "maintenance.organization_archives";
        expect(event.tags?.error_kind).toBe(archive ? "db.query_failed" : "maintenance.sweep_failed");
        expect(event.tags?.failure_code).toBe(archive ? "42501" : "ECONNRESET");
        const values = event.exception?.values ?? [];
        expect(values.some(value => value.value?.includes(`Failure in ${String(event.tags?.operation)}`))).toBe(true);
        expect(values.some(value => value.stacktrace?.frames?.length)).toBe(true);
        if (event.tags?.operation !== "maintenance.documents") {
            expect(JSON.stringify(event.breadcrumbs ?? [])).not.toContain("documents-only");
        }
    }
    expect(Sentry.getIsolationScope().getScopeData().tags.operation).toBe("outside.sweep");
    expect(JSON.stringify(events)).not.toContain(PRIVATE);
    expect(JSON.stringify(warnings)).not.toContain(PRIVATE);
    expect(sweeps.completeCleanup).not.toHaveBeenCalled();
    if (failureAt === "load") expect(db.rpc).not.toHaveBeenCalled();
    else expect(db.rpc).toHaveBeenCalledWith("expire_org_departure_archives", { p_limit: 100 });
});

it("preserves successful sweep counts and completes archive cleanup", async () => {
    sweeps.documents.mockResolvedValue(7);
    sweeps.cells.mockResolvedValue(9);
    const db = database();
    await expect(runStaleWorkSweep(db as unknown as Db)).resolves.toEqual({ documents: 7, cells: 9 });
    expect(sweeps.completeCleanup).toHaveBeenCalledWith(db, []);
    expect(sweeps.subagents).toHaveBeenCalledWith(db);
    expect(warnings).toEqual([]);
});
