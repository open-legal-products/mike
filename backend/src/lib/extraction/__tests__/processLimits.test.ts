import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { extractionCommand, ExtractionLimitError, runIsolatedExtraction, stopExtractionProcess } from "../isolated";

const directories: string[] = [];
afterEach(async () => {
  await stopExtractionProcess();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "extraction-test-"));
  directories.push(dir);
  return dir;
}

describe("parser process limits", () => {
  it.each([1024, 768])("retains the configured %i MiB heap on every platform", (memoryMb) => {
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", String(memoryMb));
    expect(extractionCommand("process.js").args).toContain(`--max-old-space-size=${memoryMb}`);
  });

  it.skipIf(process.platform !== "linux")("rejects native buffer allocations beyond the OS budget", async () => {
    const file = path.join(await scratch(), "native.cjs");
    await writeFile(file, `
      let first;
      try { first = Buffer.alloc(32 * 1024 * 1024, 1); } catch { process.exit(2); }
      try { Buffer.alloc(256 * 1024 * 1024, 1); process.exit(3); }
      catch (error) { console.log(error.message); }
      if (first[0] !== 1) process.exit(4);
    `);
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "128");
    const { command, args } = extractionCommand(file);
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/allocation failed/i);
  });

  it.skipIf(process.platform === "win32")("kills a timed-out LibreOffice process and its descendant", async () => {
    const dir = await scratch();
    const pidFile = path.join(dir, "pids.json");
    const binary = path.join(dir, "soffice");
    await writeFile(binary, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, descendant.pid]));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    vi.stubEnv("SOFFICE_BINARY_PATH", binary);
    vi.stubEnv("EXTRACTION_ISOLATION", "on");
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "2500");
    const outcome = runIsolatedExtraction("legacyOfficeText", async () => new TextEncoder().encode("synthetic legacy file").buffer).catch((error: unknown) => error);
    let pids: number[] = [];
    const until = Date.now() + 2200;
    while (Date.now() < until) {
      try { pids = JSON.parse(await readFile(pidFile, "utf8")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    try {
      expect(await outcome).toBeInstanceOf(ExtractionLimitError);
      expect(pids).toHaveLength(2);
      for (const pid of pids) {
        await expect.poll(async () => {
          try {
            process.kill(pid, 0);
            // Container PID 1 may retain dead descendants as zombies.
            if (process.platform === "linux") return !(await readFile(`/proc/${pid}/stat`, "utf8")).includes(") Z ");
            return true;
          } catch { return false; }
        }, { timeout: 1500 }).toBe(false);
      }
    } finally {
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
  });
});
