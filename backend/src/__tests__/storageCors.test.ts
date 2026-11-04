// The bucket CORS policy for direct browser uploads is generated from the
// deployment's own origins (docker/storage-cors.sh) instead of a checked-in
// file that only listed localhost. MIKE-FRONTEND-28/3D/2Z, MIKE-WORD-ADDIN-9:
// every compose install opened from a real host had its storage PUTs refused
// by CORS. See docs/deployment.md "Object-storage CORS for direct uploads".
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(__dirname, "../../..");

// Run the script exactly as the createbucket container does, with only the
// variables under test (never the developer's own FRONTEND_URL).
function corsPolicy(env: Record<string, string>) {
  const result = spawnSync("sh", [path.join(repoRoot, "docker/storage-cors.sh")], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("docker/storage-cors.sh", () => {
  it("allows the configured public origins, not only localhost", () => {
    const { status, stdout } = corsPolicy({
      FRONTEND_URL: "https://mike.firm.example/",
      WORD_ADDIN_URL: "https://word.firm.example:8443/taskpane.html",
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      CORSRules: [
        {
          AllowedOrigins: ["https://mike.firm.example", "https://word.firm.example:8443"],
          AllowedMethods: ["PUT", "HEAD"],
          AllowedHeaders: ["Content-Type", "x-amz-*"],
          ExposeHeaders: ["ETag"],
          MaxAgeSeconds: 3600,
        },
      ],
    });
  });

  it("keeps the local-development origins when nothing is configured", () => {
    const { stdout } = corsPolicy({ FRONTEND_URL: "", WORD_ADDIN_URL: "" });
    expect(JSON.parse(stdout).CORSRules[0].AllowedOrigins).toEqual([
      "http://localhost:3000",
      "https://localhost:3200",
    ]);
  });

  it("refuses a value that would corrupt the policy", () => {
    const { status, stdout, stderr } = corsPolicy({ FRONTEND_URL: 'https://a",b' });
    expect(status).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/invalid host/);
  });

  it("is what the compose createbucket job installs, fed the backend's FRONTEND_URL", () => {
    const compose = parseYaml(readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8"));
    const job = compose.services.createbucket;
    expect(job.volumes).toContain("./docker/storage-cors.sh:/storage-cors.sh:ro");
    expect(job.command).toMatch(/sh \/storage-cors\.sh > \/tmp\/storage-cors\.json/);
    expect(job.command).toMatch(/--cors-configuration file:\/\/\/tmp\/storage-cors\.json/);
    // Same interpolation as the backend service, so the two cannot disagree.
    expect(job.environment.FRONTEND_URL).toBe("${FRONTEND_URL:-http://localhost:3000}");
    expect(compose.services.backend.environment).toContain(
      "FRONTEND_URL=${FRONTEND_URL:-http://localhost:3000}",
    );
  });
});
