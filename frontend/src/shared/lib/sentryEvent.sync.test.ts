import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagnosticRoute } from "./sentryPrivacy";

/**
 * The redaction core is one privacy control mirrored into two files: the
 * backend cannot import the frontend tree at build time, so it carries a
 * copy. This test is what keeps them one control: it fails the moment the
 * marked block differs, ignoring indentation (2 vs 4 spaces).
 */
const SHARED = path.resolve(__dirname, "sentryEvent.ts");
const BACKEND = path.resolve(
    __dirname,
    "../../../../backend/src/lib/observability/sentry.ts",
);

function sharedBlock(file: string): string {
    const source = readFileSync(file, "utf8");
    const match = source.match(
        /\/\/ BEGIN shared-redaction[\s\S]*?\/\/ END shared-redaction/,
    );
    if (!match) throw new Error(`no shared-redaction block in ${file}`);
    return match[0]
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
}

describe("shared-redaction block", () => {
    it("keeps the outbound envelope privacy boundary identical", () => {
        expect(readFileSync(path.resolve(__dirname, "sentryPrivacy.ts"), "utf8"))
            .toBe(readFileSync(path.resolve(__dirname, "../../../../backend/src/lib/observability/sentryPrivacy.ts"), "utf8"));
    });
    it("is identical in the backend and the shared scrubber", () => {
        expect(sharedBlock(BACKEND)).toBe(sharedBlock(SHARED));
    });
});

/**
 * The default DSNs are the same table in both files, so every runtime of a
 * community install reports to the same Sentry organisation. Each runtime's
 * own tests only compare it with its own table; this is the drift check.
 */
function dsnTable(file: string): string {
    const match = readFileSync(file, "utf8").match(
        /export const MIKE_SENTRY_DSN = \{[\s\S]*?\}(?: as const)?;/,
    );
    if (!match) throw new Error(`no MIKE_SENTRY_DSN table in ${file}`);
    return match[0]
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
}

it("keeps the default DSN table identical in the backend and the shared scrubber", () => {
    expect(dsnTable(BACKEND)).toBe(dsnTable(SHARED));
    expect(dsnTable(SHARED)).toMatch(/backend:\s*"https:\/\/[0-9a-f]+@o\d+\.ingest/);
});


it('retains the fixed vocabulary of every Express mount without parameter names', () => {
    const app = readFileSync(path.resolve(__dirname, '../../../../backend/src/app.ts'), 'utf8');
    const routes = [...app.matchAll(/app\.(?:use|get)\("([^"]+)"/g)].map(match => match[1]);
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
        expect(diagnosticRoute(route)).toBe(route.replace(/:[^/]+/g, ':id'));
    }
});
