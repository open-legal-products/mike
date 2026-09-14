import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// The compose stack has no migration runner: `db-init` loads schema.sql on a
// fresh volume and then REPLAYS a hard-coded list of migrations, because an
// existing volume skips schema.sql entirely and would otherwise never see a
// new table. Adding a migration without adding it here is silent — the stack
// boots fine and only the feature that needs the new object breaks, at
// runtime, in whatever container happens to touch it first.
//
// The list starts at 20260823_01 (everything older predates the replay block
// and is baked into schema.sql for every volume that exists today), so the
// invariant this test enforces is: every migration from that file onward must
// be BOTH mounted and psql'd by db-init.
const REPLAY_FROM = "20260823_01";

const repoRoot = path.resolve(__dirname, "../../..");

describe("docker-compose db-init migration replay", () => {
    const compose = readFileSync(
        path.join(repoRoot, "docker-compose.yml"),
        "utf8",
    );
    const migrations = readdirSync(path.join(repoRoot, "backend/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .filter((f) => f >= REPLAY_FROM)
        .sort();

    it("has migrations to check", () => {
        expect(migrations.length).toBeGreaterThan(0);
    });

    it.each(migrations)("mounts and applies %s", (file) => {
        // Plain string search, no dynamically built RegExp: the filename
        // comes from readdirSync so nothing hostile reaches it, but a regex
        // assembled from it still needs every metacharacter escaped
        // (CodeQL js/incomplete-sanitization), and an exact-substring probe
        // needs none.
        const needle = `./backend/migrations/${file}:`;
        const mountLine = compose
            .split("\n")
            .find((line) => line.includes(needle));
        expect(
            mountLine,
            `docker-compose.yml does not mount backend/migrations/${file} into db-init`,
        ).toBeDefined();
        const containerPath = mountLine!
            .slice(mountLine!.indexOf(needle) + needle.length)
            .split(":")[0]
            .trim();
        expect(
            compose.includes(`-f ${containerPath};`),
            `docker-compose.yml mounts ${file} at ${containerPath} but never psql's it`,
        ).toBe(true);
    });
});

// Migrations get re-dated whenever another branch claims their slot, and the
// rename is easy to finish in the directory while leaving the OLD filename
// quoted in prose or, worse, in product copy: an operator who reaches the
// "the database is missing this migration" state is then told to apply a file
// that does not exist. Anything that spells out a migration path must spell
// out one that is really there.
describe("migration filenames quoted outside backend/migrations", () => {
    const searchRoots = [
        "README.md",
        "docker-compose.yml",
        "docs",
        "backend/src",
        "frontend/src",
    ];
    const migrationReference = /backend\/migrations\/([A-Za-z0-9_.-]+\.sql)/g;

    const walk = (relative: string): string[] => {
        const absolute = path.join(repoRoot, relative);
        let entries;
        try {
            entries = readdirSync(absolute, { withFileTypes: true });
        } catch {
            return [absolute]; // a file, not a directory
        }
        return entries.flatMap((entry) =>
            entry.name === "node_modules" || entry.name.startsWith(".")
                ? []
                : walk(path.join(relative, entry.name)),
        );
    };

    const existing = new Set(
        readdirSync(path.join(repoRoot, "backend/migrations")),
    );

    const references = searchRoots
        .flatMap(walk)
        .filter((file) => /\.(ts|tsx|md|yml|yaml|json)$/.test(file))
        .flatMap((file) =>
            [...readFileSync(file, "utf8").matchAll(migrationReference)].map(
                (match) => ({
                    file: path.relative(repoRoot, file),
                    name: match[1],
                }),
            ),
        );

    it("finds references to check", () => {
        expect(references.length).toBeGreaterThan(0);
    });

    it("names only migrations that exist", () => {
        const dangling = references.filter((ref) => !existing.has(ref.name));
        expect(
            dangling.map((ref) => `${ref.file} -> ${ref.name}`),
            "a migration named outside backend/migrations/ does not exist",
        ).toEqual([]);
    });
});
