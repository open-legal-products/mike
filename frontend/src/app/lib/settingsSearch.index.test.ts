import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_SEARCH_ENTRIES } from "./settingsSearch";

/**
 * Every result must land somewhere: its page must exist, and the heading its
 * hash names must be written in the source of that page or a component it
 * renders. This keeps the index from drifting when a section is renamed.
 */

const SRC = join(__dirname, "..");
const PAGES = join(SRC, "(pages)", "settings");

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
}

const componentIds = new Set<string>();
for (const file of [...sources(PAGES), ...sources(join(SRC, "components"))]) {
    for (const match of readFileSync(file, "utf8").matchAll(/\bid="([a-z0-9-]+)"/g))
        componentIds.add(match[1]);
}

describe("settings search index", () => {
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
        it(`${entry.id} points at an existing page and section`, () => {
            const [path, hash] = entry.href.split("#");
            const route = path.replace(/^\/settings\/?/, "");
            expect(statSync(join(PAGES, route, "page.tsx")).isFile()).toBe(true);
            if (hash) expect(componentIds.has(hash), `id="${hash}"`).toBe(true);
        });
    }
});
