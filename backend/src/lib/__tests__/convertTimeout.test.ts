import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtimeConfig", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtimeConfig")>();
  return { ...actual, uploadConversionTimeoutMs: () => 200 };
});

let directory: string;
let officeFileToPdf: typeof import("../convert").officeFileToPdf;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mike-convert-test-"));
  // Stand in for a soffice process that never exits.
  const binary = join(directory, "soffice");
  await writeFile(binary, "#!/bin/sh\nsleep 30\n");
  await chmod(binary, 0o755);
  process.env.SOFFICE_BINARY_PATH = binary;
  vi.resetModules();
  ({ officeFileToPdf } = await import("../convert"));
});

afterEach(async () => {
  delete process.env.SOFFICE_BINARY_PATH;
  await rm(directory, { recursive: true, force: true });
});

describe("office conversion deadline", () => {
  it("kills a conversion that outlives its deadline and removes its profile", async () => {
    const outputDirectory = join(directory, "work");
    const startedAt = Date.now();

    await expect(
      officeFileToPdf(join(directory, "source.docx"), outputDirectory),
    ).rejects.toThrow(/timed out after 200ms/);

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(existsSync(join(outputDirectory, "libreoffice-profile"))).toBe(false);
  });
});
