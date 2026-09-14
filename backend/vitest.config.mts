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
            include: ["src/lib/**"],
            // No-regression RATCHET floor, not a target. src/lib/** spans the
            // tested libs (access, storage keys/dispositions, downloadTokens,
            // userApiKeys provider/env checks, chat doc resolution,
            // llm model resolution, chat citations, userLookup,
            // documentVersions, userDataCleanup, docxTrackedChanges,
            // documentTypes, chat prompts, workflow catalog ingestion) AND the large,
            // lightly tested feature libs (courtlistener, mcp, chat tool
            // dispatch, llm providers, spreadsheet handling). Measured on
            // this tree: 56.44% statements, 50.03% branches, 57.92% functions,
            // 57.93% lines. These floors sit just below that (rounded down to
            // whole percents) so CI
            // fails on a *drop*. Floors only go up: when you add tests, raise
            // them in the same PR. Backlog + per-area status:
            // docs/testing-coverage.md.
            thresholds: {
                statements: 56,
                branches: 50,
                functions: 57,
                lines: 57,
            },
        },
    },
});
