// The product version lives in one place, /VERSION, and everything that names
// a release derives from it: the publish workflow (mike@<version>+<sha12>
// releases and image tags) and the compose stack's default image tag, so a
// fresh `docker compose pull` runs the images that match the checked-out
// migrations. This keeps the copies in step. See docs/observability.md.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "dotenv";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(__dirname, "../../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

// Semver core with an optional prerelease; the commit is the build metadata,
// never part of VERSION (frontend/src/shared/lib/releaseName.cjs).
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe("product version", () => {
    const version = read("VERSION").trim();

    it("is a semver string without build metadata", () => {
        expect(version).toMatch(SEMVER);
        expect(read("VERSION")).toBe(`${version}\n`);
    });

    it("is the default image tag for every published image in docker-compose.yml", () => {
        const compose = read("docker-compose.yml");
        const tags = [...compose.matchAll(/mike-(backend|frontend):\$\{MIKE_IMAGE_TAG:-([^}]+)\}/g)];
        expect(tags.map((m) => m[1]).sort()).toEqual(["backend", "frontend"]);
        for (const [, image, tag] of tags) {
            expect(tag, `default tag of the ${image} image`).toBe(version);
        }
    });

    it("is what the deployment docs tell operators to pin", () => {
        const deployment = read("docs/deployment.md");
        expect(deployment).toContain(`MIKE_IMAGE_TAG=${version}`);
    });

    it("preserves published image release identity when the sample env_file is applied", () => {
        const imageEnv = { MIKE_VERSION: version, GIT_SHA: "0123456789abcdef" };
        const runtimeEnv = { ...imageEnv, ...parse(read(".env.example")) };
        expect(runtimeEnv.MIKE_VERSION).toBe(version);
        expect(runtimeEnv.GIT_SHA).toBe(imageEnv.GIT_SHA);
    });

    it("serializes publication across refs and rechecks saved builds in failed-job retries", () => {
        const workflow = parseYaml(read(".github/workflows/publish-images.yml"));
        expect(workflow.concurrency.group).toBe("publish-images");
        expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
        const steps = workflow.jobs.build.steps;
        expect(steps.find((step: { id?: string }) => step.id === "saved").run)
            .toBe("node scripts/publish-images.mjs prepare");
        expect(steps.find((step: { id?: string }) => step.id === "build").if)
            .toBe("steps.saved.outputs[format('{0}_digest', matrix.image)] == ''");
        expect(read(".github/workflows/publish-images.yml")).not.toContain("actions/download-artifact");
    });

    it.each([
        ["branch", "main", `${version}-dev.42 main`],
        ["branch", "fix/example", `${version}-dev.42`],
        ["tag", `v${version}`, version.includes("-") ? version : `${version} latest`],
    ])("publishes the correct image tags for %s %s", (refType, refName, tags) => {
        const workflow = parseYaml(read(".github/workflows/publish-images.yml"));
        const script = workflow.jobs.identity.steps.find((step: { id?: string }) => step.id === "identity").run;
        const dir = mkdtempSync(path.join(tmpdir(), "mike-publish-identity-"));
        const output = path.join(dir, "output");
        try {
            execFileSync("bash", ["-c", script], {
                cwd: repoRoot,
                env: {
                    PATH: process.env.PATH,
                    REF_TYPE: refType, REF_NAME: refName, RUN_NUMBER: "42",
                    SHA: "0123456789abcdef", OWNER: "open-legal-products",
                    SENTRY_ORG: "", SENTRY_PROJECT_FRONTEND: "", SENTRY_PROJECT_BACKEND: "",
                    HAS_TOKEN: "false", FORK_DSN_FRONTEND: "", FORK_DSN_BACKEND: "",
                    GITHUB_OUTPUT: output,
                },
            });
            expect(readFileSync(output, "utf8").split("\n")).toContain(`tags=${tags}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
