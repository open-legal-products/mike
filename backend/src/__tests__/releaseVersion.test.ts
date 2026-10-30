// The product version lives in one place, /VERSION, and everything that names
// a release derives from it: the publish workflow (mike@<version>+<sha12>
// releases and image tags) and the compose stack's default image tag, so a
// fresh `docker compose pull` runs the images that match the checked-out
// migrations. This keeps the copies in step. See docs/observability.md.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
});
