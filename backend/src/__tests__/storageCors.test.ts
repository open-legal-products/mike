// The bucket CORS policy for direct browser uploads is generated from the
// origins the backend trusts (docker/storage-cors.mjs, which calls the
// backend's configuredAllowedOrigins) instead of a checked-in file that only
// listed localhost. MIKE-FRONTEND-28/3D/2Z, MIKE-WORD-ADDIN-9:
// every compose install opened from a real host had its storage PUTs refused
// by CORS. See docs/deployment.md "Object-storage CORS for direct uploads".
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(__dirname, "../../..");

// Run the script exactly as the storage-cors container does, with only the
// variables under test (never the developer's own FRONTEND_URL).
function corsPolicy(env: Record<string, string>, nodeArgs = ["--experimental-strip-types"]) {
  const result = spawnSync(
    process.execPath,
    // The flag lets Node 22.6-22.17 load origins.ts too; later 22.x ignore it.
    [...nodeArgs, path.join(repoRoot, "docker/storage-cors.mjs")],
    { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" },
  );
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("docker/storage-cors.mjs", () => {
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

  it("also allows every extra client origin the backend trusts (ALLOWED_ORIGINS)", () => {
    const { status, stdout } = corsPolicy({
      FRONTEND_URL: "https://mike.example.com",
      ALLOWED_ORIGINS: "http://localhost:3000,https://word.example.com",
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout).CORSRules[0].AllowedOrigins).toEqual(
      expect.arrayContaining([
        "https://mike.example.com",
        "http://localhost:3000",
        "https://word.example.com",
      ]),
    );
    expect(JSON.parse(stdout).CORSRules[0].AllowedOrigins[0]).toBe("https://mike.example.com");
  });

  it("skips an ALLOWED_ORIGINS entry the backend's exact-match CORS could never match", () => {
    const { status, stdout, stderr } = corsPolicy({
      FRONTEND_URL: "https://mike.example.com",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: "https://ok.example.com, https://app.example.com/path ,not a url",
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout).CORSRules[0].AllowedOrigins).toEqual([
      "https://mike.example.com",
      "https://ok.example.com",
    ]);
    expect(stderr).toMatch(/skipping ALLOWED_ORIGINS entry .*app\.example\.com\/path/);
    expect(stderr).toMatch(/skipping ALLOWED_ORIGINS entry .*not a url/);
  });

  it("keeps the local-development origins when nothing is configured", () => {
    const { stdout } = corsPolicy({ FRONTEND_URL: "", WORD_ADDIN_URL: "" });
    expect(JSON.parse(stdout).CORSRules[0].AllowedOrigins).toEqual([
      "http://localhost:3000",
      "https://localhost:3200",
    ]);
  });

  // The stack waits for this script (createbucket, then the backend), so a
  // bad input must never stop it: one clear line, and a policy that still
  // allows the loopback development origins.
  it.each([
    ["a value that would corrupt the policy", 'https://a",b'],
    ["a URL without a scheme", "mike.example"],
    ["an underscore host no browser sends as an Origin", "http://mike_app:3000"],
  ])("never puts %s in the policy, and still exits 0", (_, frontendUrl) => {
    const { status, stdout, stderr } = corsPolicy({ FRONTEND_URL: frontendUrl, NODE_ENV: "production" });
    expect(status).toBe(0);
    expect(JSON.parse(stdout).CORSRules[0].AllowedOrigins).toEqual([
      "http://localhost:3000",
      "https://localhost:3200",
    ]);
    expect(stderr).toContain(`storage-cors: skipping ${JSON.stringify(frontendUrl)}`);
    expect(stderr).toMatch(/adding the loopback development origins/);
  });

  it("keeps the valid origin when only the other URL is bad", () => {
    const { status, stdout } = corsPolicy({
      FRONTEND_URL: "https://mike.example.com",
      WORD_ADDIN_URL: "word.example.com",
      NODE_ENV: "production",
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout).CORSRules[0].AllowedOrigins).toEqual([
      "https://mike.example.com",
      "http://localhost:3000",
      "https://localhost:3200",
    ]);
  });

  it("falls back, not fails, on an image built before origins.ts existed", () => {
    const { status, stdout, stderr } = corsPolicy({
      FRONTEND_URL: "https://mike.example.com",
      MIKE_ORIGINS_MODULE: path.join(os.tmpdir(), "no-such-dir", "dist", "lib", "origins.js"),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout).CORSRules[0].AllowedOrigins).toEqual([
      "http://localhost:3000",
      "https://localhost:3200",
    ]);
    expect(stderr).toMatch(/cannot load the backend's origins module/);
  });

  it("is what compose installs, generated from exactly the backend's origin inputs", () => {
    const compose = parseYaml(readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8"));
    const { backend, createbucket } = compose.services;
    const generator = compose.services["storage-cors"];
    // Same image (so the same release's origins.ts) and the same inputs as
    // the backend: its env_file list and its origin overrides.
    expect(generator.image).toBe(backend.image);
    expect(generator.env_file).toEqual(backend.env_file);
    for (const name of ["NODE_ENV", "FRONTEND_URL"]) {
      const line = backend.environment.find((e: string) => e.startsWith(`${name}=`));
      expect(generator.environment).toContain(line);
    }
    expect(generator.environment).toContain("MIKE_ORIGINS_MODULE=/app/dist/lib/origins.js");
    // It receives the backend's whole env_file (secrets included) but only
    // prints JSON, so it gets no network at all.
    expect(generator.network_mode).toBe("none");
    expect(generator.volumes).toContain("./docker/storage-cors.mjs:/storage-cors.mjs:ro");
    expect(generator.command.join(" ")).toMatch(/node \/storage-cors\.mjs > \/cors\/storage-cors\.json/);
    expect(createbucket.depends_on["storage-cors"]).toEqual({
      condition: "service_completed_successfully",
    });
    expect(createbucket.command).toMatch(/--cors-configuration file:\/\/\/cors\/storage-cors\.json/);
  });
});
