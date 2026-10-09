import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// Every database records the migrations it has applied in
// public.schema_migrations, and backend/scripts/migrate.sh applies whatever
// the ledger does not list. A fresh install never runs the files: schema.sql
// already contains their effect and lists each filename in the ledger, so a
// migration missing from that list is re-run over a schema that already has
// it on the first `migrate.sh up` (including Compose's db-init), and one
// listed but absent from the directory is reported as renamed or removed.
const repoRoot = path.resolve(__dirname, "../../..");
const read = (relative: string) =>
    readFileSync(path.join(repoRoot, relative), "utf8");
const migrations = readdirSync(path.join(repoRoot, "backend/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();

describe("schema.sql migration ledger", () => {
    const schema = read("backend/schema.sql");
    const manifestStart = schema.indexOf(
        "insert into public.schema_migrations (filename) values",
    );
    const manifest = schema
        .slice(manifestStart, schema.indexOf(";", manifestStart))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("("))
        .map((line) => line.match(/^\('([^']+)'\),?$/)?.[1]);

    it("has a manifest", () => {
        expect(manifestStart).toBeGreaterThan(-1);
        expect(manifest.length).toBeGreaterThan(0);
        expect(manifest, "unparseable manifest line").not.toContain(undefined);
    });

    it("lists every migration in backend/migrations, in order", () => {
        expect(
            manifest,
            "add the new migration's filename to the schema_migrations list at the end of backend/schema.sql",
        ).toEqual(migrations);
    });

    it("names the ledger migration the runner bootstraps from", () => {
        const ledgerMigration = read("backend/scripts/migrate.sh").match(
            /^LEDGER_MIGRATION="([^"]+)"$/m,
        )?.[1];
        expect(migrations).toContain(ledgerMigration);
    });
});

// migrate.sh wraps each file in a transaction with its ledger row unless the
// file cannot run in one. The rule lives in the script (runs_in_transaction);
// these tests source it rather than restate it.
describe("migrate.sh transaction detection", () => {
    const script = path.join(repoRoot, "backend/scripts/migrate.sh");
    const runsInTransaction = (file: string) => {
        try {
            execFileSync(
                "bash",
                ["-c", 'source "$1" && runs_in_transaction "$2"', "test", script, file],
                { stdio: "pipe" },
            );
            return true;
        } catch {
            return false;
        }
    };

    it.each([
        ["plain DDL", "create table t (id int);\n", true],
        [
            "a plpgsql body (begin without a semicolon, end;)",
            "create function f() returns void language plpgsql as $$\nbegin\n  perform 1;\nend;\n$$;\n",
            true,
        ],
        ["the opt-out marker", "-- migrate:no-transaction\nselect 1;\n", false],
        ["its own begin/commit", "BEGIN;\nselect 1;\nCOMMIT;\n", false],
        ["start transaction", "start transaction;\nselect 1;\ncommit work;\n", false],
        ["create index concurrently", "create index concurrently i on t (id);\n", false],
    ])("%s -> %s", (_label, sql, expected) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "migrate-tx-"));
        try {
            const file = path.join(dir, "m.sql");
            writeFileSync(file, sql);
            expect(runsInTransaction(file)).toBe(expected);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // Shipped files that manage their own transaction or build an index
    // concurrently. They cannot be edited to add the marker, so detection has
    // to keep finding them; any later file that runs outside a transaction
    // must say so with the marker (see AGENTS.md).
    const unmarkedOutsideTransaction = [
        "20260805_01_narrow_service_role_grants.sql",
        "20260813_01_user_id_foreign_keys.sql",
        "20260828_02_upload_sessions.sql",
        "20260904_01_organization_access.sql",
        "20260904_02_migrate_legacy_sharing.sql",
        "20260917_01_organization_access_followup.sql",
        "20260921_01_chat_activity.sql",
    ];

    it("runs every other migration in a transaction unless it is marked", () => {
        const outside = migrations.filter(
            (file) =>
                !runsInTransaction(path.join(repoRoot, "backend/migrations", file)),
        );
        const unmarked = outside.filter(
            (file) =>
                !/^-- migrate:no-transaction\s*$/m.test(
                    read(`backend/migrations/${file}`),
                ),
        );
        expect(
            unmarked,
            "add a `-- migrate:no-transaction` line to a new migration that cannot run in a transaction",
        ).toEqual(unmarkedOutsideTransaction);
    });
});

describe("docker-compose db-init", () => {
    const compose = read("docker-compose.yml");

    it("mounts the whole migrations directory and the runner", () => {
        expect(compose).toContain("- ./backend/migrations:/migrations:ro");
        expect(compose).toContain(
            "- ./backend/scripts/migrate.sh:/migrate.sh:ro",
        );
        expect(compose).toContain("MIGRATIONS_DIR: /migrations");
    });

    it("fails closed when schema.sql, adoption or a migration fails", () => {
        expect(compose).toContain("-f /schema.sql || exit 1;");
        expect(compose).toContain("bash /adopt-ledger.sh || exit 1;");
        expect(compose).toContain("bash /migrate.sh up || exit 1;");
    });

    it("adopts pre-ledger volumes up to a migration that exists", () => {
        const adopt = read("docker/db-init/adopt-ledger.sh");
        const lastReplayed = adopt.match(/^LAST_REPLAYED=(\S+)$/m)?.[1];
        expect(migrations).toContain(lastReplayed);
    });

    // Older history has a duplicate slot (two 20260822_01 files); the
    // convention is enforced from the first migration after it.
    it("uses a unique date and sequence for every dated migration", () => {
        const slots = migrations
            .filter((file) => file >= "20260823_01")
            .map((file) => file.match(/^\d{8}_\d{2}_/)?.[0])
            .filter(Boolean);
        expect(new Set(slots).size).toBe(slots.length);
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
