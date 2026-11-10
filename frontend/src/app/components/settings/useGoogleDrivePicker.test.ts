import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/mikeApi")>()),
  createGoogleDrivePickerSession: mocks.session,
}));
vi.mock("@/app/lib/googlePicker", () => ({
  openGoogleDrivePicker: mocks.open,
}));

import { MikeApiError } from "@/app/lib/mikeApi";
import { useGoogleDrivePicker } from "./useGoogleDrivePicker";

const session = {
  accessToken: "access-token",
  expiresAt: "2026-10-16T12:00:00.000Z",
  appId: "123456789",
  developerKey: "picker-key",
};

async function addFiles(workspace?: string) {
  const { result } = renderHook(() => useGoogleDrivePicker(workspace));
  await act(() => result.current.addFiles());
  return result.current.message;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue(session);
});

describe("useGoogleDrivePicker", () => {
  it("opens the Picker with the session and counts the added files", async () => {
    mocks.open.mockResolvedValue([
      { id: "1", name: "a.pdf", mimeType: "application/pdf" },
      { id: "2", name: "b.pdf", mimeType: "application/pdf" },
      { id: "3", name: "c.pdf", mimeType: "application/pdf" },
    ]);
    expect(await addFiles()).toBe(
      "Added 3 files. Mike can now search and read them.",
    );
    expect(mocks.open).toHaveBeenCalledWith(session);
  });

  it("opens the Drive connection of the workspace it is given", async () => {
    mocks.open.mockResolvedValue([]);
    await addFiles("org-1");
    expect(mocks.session).toHaveBeenCalledWith("org-1");
  });

  it("says nothing was added when the Picker is closed", async () => {
    mocks.open.mockResolvedValue([]);
    expect(await addFiles()).toBe("No files added.");
  });

  it("shows intentional 4xx text but never a raw failure", async () => {
    mocks.session.mockRejectedValueOnce(
      new MikeApiError({
        status: 409,
        message: "Google Drive is not connected for this account.",
      }),
    );
    expect(await addFiles()).toBe(
      "Google Drive is not connected for this account.",
    );
    mocks.open.mockRejectedValueOnce(new Error("gapi exploded at line 42"));
    expect(await addFiles()).toBe(
      "Google Drive could not be opened. Try again.",
    );
  });

  it("leaves an MFA challenge to the page's step-up flow", async () => {
    const mfa = new MikeApiError({
      status: 403,
      code: "mfa_verification_required",
      message: "Verify",
    });
    mocks.session.mockRejectedValueOnce(mfa);
    const { result } = renderHook(() => useGoogleDrivePicker());
    await expect(result.current.addFiles()).rejects.toBe(mfa);
  });
});
