// The outbound privacy boundary keeps a tag only when its value is in the
// closed vocabulary (sentryPrivacy.ts). A report in the web app or the Word
// add-in that names a component or stage the boundary does not know still
// compiles and still runs, and then arrives in Sentry as "Failure in
// application". This reads every such literal in both clients and fails on
// the first one the boundary would drop. The backend has the same test.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_VOCABULARY } from "./sentryPrivacy";

const ROOTS = [resolve(__dirname, "../../app"), resolve(__dirname, ".."), resolve(__dirname, "../../../../word-addin/src")];

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === "node_modules") continue;
            walk(full, out);
        } else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !/(^|\/)__tests__\//.test(full)) {
            out.push(full);
        }
    }
    return out;
}

const FILES = [...new Set(ROOTS.flatMap((root) => walk(root)))];

describe("diagnostic tag vocabulary (web app and Word add-in)", () => {
    it.each(["component", "stage", "operation", "error_kind"])(
        "every `%s:` literal in the clients is a value the privacy boundary keeps",
        (tag) => {
            const vocabulary = DIAGNOSTIC_VOCABULARY[tag]!;
            const pattern = new RegExp(`\\b${tag}:\\s*"([^"\\n]+)"`, "g");
            const unknown: Array<{ file: string; value: string }> = [];
            for (const file of FILES) {
                for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
                    if (!vocabulary.has(match[1]!)) unknown.push({ file: relative(resolve(__dirname, "../../../.."), file).split(sep).join("/"), value: match[1]! });
                }
            }
            expect(unknown, `add these to ${tag} in sentryPrivacy.ts (both copies)`).toEqual([]);
        },
    );

    it("scans both clients", () => {
        expect(FILES.some((f) => f.includes("/word-addin/"))).toBe(true);
        expect(FILES.some((f) => f.includes("/frontend/src/app/"))).toBe(true);
    });
});
