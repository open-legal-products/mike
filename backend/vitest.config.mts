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
            // The whole server, not just src/lib/**. The old scope silently
            // left routes/, modules/, workers/ and middleware/ out of the
            // report entirely, so the ratchet below could not see a
            // regression there — and the headline percentage described a
            // fraction of the codebase rather than the codebase.
            include: ["src/**"],
            // Test files and their fixtures are the measuring instrument, not
            // the thing measured. (Spelled out rather than left to vitest's
            // defaults because setting `exclude` at all replaces them.)
            exclude: ["src/**/__tests__/**", "src/**/*.test.ts", "**/*.d.ts"],
            // No-regression RATCHET floor, not a target. The measured scope
            // spans well-tested libs (access, storage keys/dispositions,
            // downloadTokens, userApiKeys provider/env checks, chat doc
            // resolution, llm model resolution, chat citations, userLookup,
            // documentVersions, userDataCleanup, docxTrackedChanges,
            // documentTypes, chat prompts, workflow catalog ingestion) and the
            // route/module layer the integration suites drive, alongside the
            // large still-untested feature libs (courtlistener, mcp, chat tool
            // dispatch, llm providers, spreadsheet handling), so the global
            // number stays modest.
            //
            // Measured on this tree with the widened src/** scope: 47.56%
            // statements, 40.86% branches, 49.78% functions, 49.20% lines.
            // (Widening the scope from src/lib/** moved the denominator, not
            // the tests; the absolute numbers are higher than when this scope
            // was first proposed because main has since landed tested code.)
            // The floors below sit ~2 points under that, so CI fails on a real
            // *drop* rather than on measurement noise. Floors only go up: when
            // you add tests, raise them in the same PR. Backlog + per-area
            // status: docs/testing-coverage.md.
            thresholds: {
                statements: 45,
                branches: 38,
                functions: 47,
                lines: 47,
            },
        },
    },
});
