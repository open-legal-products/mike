import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import fs, { existsSync } from "node:fs";
import { diagnosticErrorTags } from "../observability/sentryPrivacy";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const timing = vi.hoisted(() => ({ timeoutMs: 200 }));

vi.mock("../runtimeConfig", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtimeConfig")>();
  return { ...actual, uploadConversionTimeoutMs: () => timing.timeoutMs };
});

let directory: string;
let officeFileToPdf: typeof import("../convert.js").officeFileToPdf;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mike-convert-test-"));
  // Stand in for a soffice process that never exits.
  const binary = join(directory, "soffice");
  // Replace the shell with the sleeper so SIGKILL targets the process holding
  // the stdio pipes too. Otherwise the orphaned `sleep` keeps stderr open and
  // Node cannot emit `close` until the full 30 seconds have elapsed.
  await writeFile(binary, "#!/bin/sh\nexec sleep 30\n");
  await chmod(binary, 0o755);
  process.env.SOFFICE_BINARY_PATH = binary;
  vi.resetModules();
  ({ officeFileToPdf } = await import("../convert.js"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  timing.timeoutMs = 200;
  delete process.env.SOFFICE_BINARY_PATH;
  await rm(directory, { recursive: true, force: true });
});

describe("office conversion deadline", () => {
  it("kills a conversion that outlives its deadline and removes its profile", async () => {
    const outputDirectory = join(directory, "work");
    const startedAt = Date.now();

    const failure = await officeFileToPdf(
      join(directory, "source.docx"),
      outputDirectory,
    ).catch((error) => error);
    expect(failure.message).toMatch(/timed out after 200ms/);
    expect(diagnosticErrorTags(failure)).toEqual({
      failure_code: "conversion_timeout",
    });

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(existsSync(join(outputDirectory, "libreoffice-profile"))).toBe(
      false,
    );
  });
});

it("distinguishes an unavailable converter from a rejected document without stderr", async () => {
  timing.timeoutMs = 5000;
  await writeFile(
    join(directory, "soffice"),
    '#!/bin/sh\necho "PRIVATE_DOCUMENT" >&2\nexit 1\n',
  );
  const failure = await officeFileToPdf(
    join(directory, "PRIVATE_DOCUMENT.docx"),
    join(directory, "work"),
  ).catch((error) => error);
  expect(diagnosticErrorTags(failure)).toEqual({
    failure_code: "conversion_failed",
  });
  vi.resetModules();
  vi.spyOn(fs, "accessSync").mockImplementation(() => {
    throw new Error("missing");
  });
  const converter = await import("../convert.js");
  const missing = await converter
    .officeFileToPdf("PRIVATE_DOCUMENT.docx", directory)
    .catch((error) => error);
  expect(diagnosticErrorTags(missing)).toEqual({
    failure_code: "conversion_unavailable",
  });
});
