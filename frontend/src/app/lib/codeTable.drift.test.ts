import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_KINDS } from "@/shared/lib/userError";

/**
 * `CODE_KINDS` decides what a failure is called and whether Retry and
 * "Contact support" are offered, keyed by the `code` a server sent. Before
 * this guard the table listed codes no server had ever emitted
 * (`validation_error`, `service_unavailable`, `too_many_requests`,
 * `unauthorized`, …): it looked like coverage, while every real failure
 * fell through to the status-based classification underneath.
 *
 * Nothing throws when a code is wrong, so only a drift check catches it.
 * Every key must appear as a string literal in a tree that produces
 * responses: the API, or the Next proxy route that answers when the API
 * cannot be reached.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const SOURCE_TREES = [
    path.join(ROOT, "backend", "src"),
    path.join(ROOT, "frontend", "src", "app", "api"),
];

function collectSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectSources(full, out);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
            out.push(readFileSync(full, "utf8"));
        }
    }
    return out;
}

describe("CODE_KINDS", () => {
    const sources = SOURCE_TREES.flatMap((tree) => collectSources(tree));

    it("reads more than one file per tree", () => {
        expect(sources.length).toBeGreaterThan(100);
    });

    it("only lists codes a server actually emits", () => {
        const unknown = Object.keys(CODE_KINDS).filter((code) => {
            const literal = `"${code}"`;
            return !sources.some((source) => source.includes(literal));
        });
        expect(unknown).toEqual([]);
    });
});
