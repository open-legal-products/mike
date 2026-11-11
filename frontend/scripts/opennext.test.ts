// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_SUFFIX, main } from "./opennext.mjs";

// OpenNext's own root detection, so these tests break if its rules change.
const OPENNEXT_HELPER = path.resolve(
    __dirname,
    "../node_modules/@opennextjs/aws/dist/build/helper.js",
);
// OpenNext's build step that compiles .env files into the Worker.
const OPENNEXT_COMPILE_ENV = path.resolve(
    __dirname,
    "../node_modules/@opennextjs/cloudflare/dist/cli/build/open-next/compile-env-files.js",
);

let repo: string;
let app: string;
let log: string;

/** A stand-in for opennextjs-cloudflare that records what OpenNext would see. */
function fakeOpenNext(exitCodes: Record<string, number> = {}) {
    const bin = path.join(repo, "fake-opennext.mjs");
    fs.writeFileSync(
        bin,
        `#!${process.execPath}
import fs from "node:fs";
const { findPackagerAndRoot } = await import(${JSON.stringify(OPENNEXT_HELPER)});
const { compileEnvFiles } = await import(${JSON.stringify(OPENNEXT_COMPILE_ENV)});
const command = process.argv[2];
const { root } = findPackagerAndRoot(process.cwd());
if (command === "build" && !process.env.FAKE_SKIP_ENV_FILE) {
    compileEnvFiles({ outputDir: ".open-next", monorepoRoot: root, appPath: process.cwd() });
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, root, files: fs.readdirSync(".").filter((f) => f !== ".open-next").sort() }) + "\\n");
process.exit(${JSON.stringify(exitCodes)}[command] ?? 0);
`,
    );
    fs.chmodSync(bin, 0o755);
    return bin;
}

const calls = () =>
    fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        : [];

/** The app directory's files, leaving out the build output. */
const appFiles = () =>
    fs.readdirSync(app).filter((file) => file !== ".open-next").sort();

const builtEnv = () => path.join(app, ".open-next", "cloudflare", "next-env.mjs");

beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennext-root-")));
    app = path.join(repo, "frontend");
    log = path.join(repo, "calls.log");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(repo, "package-lock.json"), "{}");
    fs.writeFileSync(path.join(app, "package-lock.json"), "app lock");
    fs.writeFileSync(path.join(app, "bun.lock"), "bun lock");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(repo, { recursive: true, force: true });
});

describe("scripts/opennext.mjs", () => {
    it("runs OpenNext with the repository as its root, then restores the app's lockfiles", async () => {
        // Without the wrapper, OpenNext stops at the app's own lockfile.
        const { findPackagerAndRoot } = await import(OPENNEXT_HELPER);
        expect(findPackagerAndRoot(app).root).toBe(app);

        const code = await main({ commands: ["build", "deploy"], appDir: app, bin: fakeOpenNext() });

        expect(code).toBe(0);
        const hidden = ["bun.lock" + HIDDEN_SUFFIX, "package-lock.json" + HIDDEN_SUFFIX];
        expect(calls()).toEqual([
            { command: "build", root: repo, files: hidden },
            { command: "deploy", root: repo, files: hidden },
        ]);
        expect(fs.readFileSync(path.join(app, "package-lock.json"), "utf8")).toBe("app lock");
        expect(fs.readFileSync(path.join(app, "bun.lock"), "utf8")).toBe("bun lock");
        expect(appFiles()).toEqual(["bun.lock", "package-lock.json"]);
    });

    it("stops at the first failing command and still restores the lockfiles", async () => {
        const code = await main({
            commands: ["build", "deploy"],
            appDir: app,
            bin: fakeOpenNext({ build: 3 }),
        });

        expect(code).toBe(3);
        expect(calls().map((call) => call.command)).toEqual(["build"]);
        expect(appFiles()).toEqual(["bun.lock", "package-lock.json"]);
    });

    it("moves nothing when the lockfiles are already gone, as in the hosted build", async () => {
        fs.rmSync(path.join(app, "package-lock.json"));
        fs.rmSync(path.join(app, "bun.lock"));

        const code = await main({ commands: ["build"], appDir: app, bin: fakeOpenNext() });

        expect(code).toBe(0);
        expect(calls()).toEqual([{ command: "build", root: repo, files: [] }]);
        expect(appFiles()).toEqual([]);
    });

    it("restores a lockfile left aside by a killed run, unless that would overwrite one", async () => {
        const hidden = path.join(app, "bun.lock" + HIDDEN_SUFFIX);
        fs.renameSync(path.join(app, "bun.lock"), hidden);

        await main({ commands: ["build"], appDir: app, bin: fakeOpenNext() });

        expect(appFiles()).toEqual(["bun.lock", "package-lock.json"]);

        fs.writeFileSync(hidden, "older bun lock");
        fs.rmSync(log);

        await expect(
            main({ commands: ["build"], appDir: app, bin: fakeOpenNext() }),
        ).rejects.toThrow(/Both bun\.lock and bun\.lock\.opennext-hidden exist/);
        expect(calls()).toEqual([]);
        expect(fs.readFileSync(path.join(app, "bun.lock"), "utf8")).toBe("bun lock");
    });

    it("keeps the repository's .env files out of the Worker", async () => {
        fs.writeFileSync(path.join(repo, ".env"), "BACKEND_SECRET=root-secret\nSHARED=from-repo\n");
        fs.writeFileSync(path.join(repo, ".env.production.local"), "PROD_SECRET=root-prod\n");
        fs.writeFileSync(path.join(app, ".env"), "SHARED=from-app\n");
        fs.writeFileSync(path.join(app, ".env.local"), "NEXT_PUBLIC_API_BASE_URL=http://app\n");

        const code = await main({ commands: ["build", "deploy"], appDir: app, bin: fakeOpenNext() });

        expect(code).toBe(0);
        const source = fs.readFileSync(builtEnv(), "utf8");
        expect(source).not.toMatch(/BACKEND_SECRET|root-secret|PROD_SECRET|root-prod|from-repo/);
        const compiled = await import(`${builtEnv()}?${Date.now()}`);
        const appEnv = { SHARED: "from-app", NEXT_PUBLIC_API_BASE_URL: "http://app" };
        expect(compiled.production).toEqual(appEnv);
        expect(compiled.development).toEqual(appEnv);
        // Like Next.js, test mode skips .env.local.
        expect(compiled.test).toEqual({ SHARED: "from-app" });
    });

    it("fails before deploying when the built env file cannot be checked", async () => {
        vi.stubEnv("FAKE_SKIP_ENV_FILE", "1");

        await expect(
            main({ commands: ["build", "deploy"], appDir: app, bin: fakeOpenNext() }),
        ).rejects.toThrow(/next-env\.mjs is missing/);
        expect(calls().map((call) => call.command)).toEqual(["build"]);
        expect(appFiles()).toEqual(["bun.lock", "package-lock.json"]);
    });
});
