// MIKE-BACKEND-9: "Failure in upload-worker / conversion" from a developer
// machine running the backend outside Docker. The Docker image installs
// LibreOffice (/usr/bin/soffice), but the official macOS installer puts
// soffice inside the app bundle and adds nothing to PATH, so the worker
// declared LibreOffice missing on a machine that had it.
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Never launch a real LibreOffice from this test: on a Mac that has it
// installed the bundle path is a real executable. The fake child fails the
// way a missing binary does (ENOENT with the attempted path), which is all
// the discovery assertion needs.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
function fakeChildThatCannotStart(binary: string) {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    child.emit(
      "error",
      Object.assign(new Error(`spawn ${binary} ENOENT`), {
        code: "ENOENT",
        syscall: `spawn ${binary}`,
        path: binary,
      }),
    );
  });
  return child;
}

let workDirectory: string;
beforeAll(async () => {
  workDirectory = await mkdtemp(join(osTmpdir(), "mike-convert-avail-"));
});
afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});
const tmpdir = () => workDirectory;
import { diagnosticErrorTags } from "../observability/sentryPrivacy";

const MAC_BUNDLE_SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice";

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

async function freshConverter() {
  vi.resetModules();
  return await import("../convert.js");
}

describe("soffice discovery", () => {
  it("finds LibreOffice in the macOS app bundle", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation((file) => {
      if (file !== MAC_BUNDLE_SOFFICE) throw new Error("missing");
    });
    spawnMock.mockImplementation((binary: string) =>
      fakeChildThatCannotStart(binary),
    );
    const { officeFileToPdf } = await freshConverter();

    const failure = await officeFileToPdf(
      "source.docx",
      tmpdir(),
    ).catch((error: unknown) => error);

    // The bundle binary was chosen and handed to spawn instead of the
    // converter giving up with conversion_unavailable before trying.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe(MAC_BUNDLE_SOFFICE);
    expect(diagnosticErrorTags(failure).failure_code).not.toBe(
      "conversion_unavailable",
    );
    expect((failure as { path?: string }).path).toBe(MAC_BUNDLE_SOFFICE);
  });

  it("says how to fix a missing LibreOffice without naming one hosting provider", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("missing");
    });
    const { officeFileToPdf } = await freshConverter();

    const failure = (await officeFileToPdf("source.docx", tmpdir()).catch(
      (error: unknown) => error,
    )) as Error;

    expect(diagnosticErrorTags(failure)).toEqual({
      failure_code: "conversion_unavailable",
    });
    expect(failure.message).toContain("SOFFICE_BINARY_PATH");
    expect(failure.message).not.toContain("Railway");
  });
});
