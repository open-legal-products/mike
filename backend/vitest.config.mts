import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        exclude: ["dist/**", "node_modules/**"],
        // Generous timeouts so cold-start module transform/import latency
        // can't cause spurious timeout failures on a cold CI runner. Warm
        // tests finish in ~1s; this only guards the pathological cold case —
        // it does not mask hangs.
        testTimeout: 20000,
        hookTimeout: 20000,
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            // The whole server, not just src/lib/** + src/modules/**. The
            // previous scope still left workers/, middleware/, jobs/ and
            // app.ts out of the report entirely, so the ratchet could not see
            // a regression there — and the headline percentage described a
            // part of the codebase rather than the codebase.
            include: ["src/**"],
            // Test files and their fixtures are the measuring instrument, not
            // the thing measured. (Spelled out rather than left to vitest's
            // defaults because setting `exclude` at all replaces them.)
            exclude: ["src/**/__tests__/**", "src/**/*.test.ts", "**/*.d.ts"],
            // No-regression RATCHET floor, not a target. The measured scope
            // spans well-tested libs (access, storage keys/dispositions,
            // downloadTokens, api-key provider/env checks, chat doc
            // resolution, llm model resolution, chat citations, userLookup,
            // documentVersions, userDataCleanup, docxTrackedChanges,
            // documentTypes, chat prompts, workflow catalog ingestion), the
            // route/service layer the integration and service suites drive,
            // and the large still-untested feature libs (courtlistener, mcp,
            // chat tool dispatch, llm providers, spreadsheet handling) — so
            // the global number stays modest.
            //
            // Measured on THIS tree with the widened src/** scope: 60.59%
            // statements, 51.98% branches, 64.77% functions, 63.18% lines —
            // slightly under the src/lib + src/modules numbers (61.34 / 52.31
            // / 66.28 / 63.97), because the workers, jobs and app wiring the
            // widening pulled in are covered only by the stack suites.
            // The floors below sit just under that, so CI fails on a real
            // *drop* rather than on measurement noise. Floors only go up: when
            // you add tests, raise them in the same PR. Backlog + per-area
            // status: docs/testing-coverage.md.
            thresholds: {
                statements: 60,
                branches: 51,
                functions: 64,
                lines: 63,
            },
        },
    },
});
