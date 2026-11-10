import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GooglePickerApi } from "./googlePicker";

type Callback = (response: Record<string, unknown>) => void;

function fakeGoogle() {
  const calls: Record<string, unknown[]> = {};
  let callback: Callback = () => {};
  const record =
    (name: string) =>
    function (this: unknown, ...args: unknown[]) {
      (calls[name] ??= []).push(args.length > 1 ? args : args[0]);
      return this;
    };
  class DocsView {
    constructor(viewId: string) {
      calls.view = [viewId];
    }
    setIncludeFolders = record("setIncludeFolders");
    setSelectFolderEnabled = record("setSelectFolderEnabled");
  }
  class PickerBuilder {
    setOAuthToken = record("setOAuthToken");
    setDeveloperKey = record("setDeveloperKey");
    setAppId = record("setAppId");
    enableFeature = record("enableFeature");
    addView = record("addView");
    setCallback(next: Callback) {
      callback = next;
      return this;
    }
    build() {
      return { setVisible: record("setVisible") };
    }
  }
  const picker = {
    PickerBuilder,
    DocsView,
    ViewId: { DOCS: "all" },
    Feature: { MULTISELECT_ENABLED: "multi", SUPPORT_DRIVES: "drives" },
    Action: { PICKED: "picked", CANCEL: "cancel" },
    Response: { ACTION: "action", DOCUMENTS: "docs" },
    Document: { ID: "id", NAME: "name", MIME_TYPE: "mimeType" },
  };
  const load = vi.fn((_api: string, options: { callback: () => void }) => {
    window.google = { picker: picker as unknown as GooglePickerApi };
    options.callback();
  });
  return { calls, load, respond: (r: Record<string, unknown>) => callback(r) };
}

const session = {
  accessToken: "access-token",
  developerKey: "picker-key",
  appId: "123456789",
};

beforeEach(() => {
  vi.resetModules();
  delete window.gapi;
  delete window.google;
  document.head.innerHTML = "";
});
afterEach(() => {
  delete window.gapi;
  delete window.google;
});

describe("openGoogleDrivePicker", () => {
  it("loads the Google API script once, then builds a multi-select Drive picker", async () => {
    const google = fakeGoogle();
    const { openGoogleDrivePicker } = await import("./googlePicker");
    const opened = openGoogleDrivePicker(session);
    const script = document.head.querySelector("script");
    expect(script?.src).toBe("https://apis.google.com/js/api.js");
    window.gapi = { load: google.load };
    script!.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(google.calls.setVisible).toEqual([true]));

    google.respond({
      action: "picked",
      docs: [{ id: "f1", name: "Lease.pdf", mimeType: "application/pdf", url: "x" }],
    });
    expect(await opened).toEqual([
      { id: "f1", name: "Lease.pdf", mimeType: "application/pdf" },
    ]);
    expect(google.calls).toMatchObject({
      setOAuthToken: ["access-token"],
      setDeveloperKey: ["picker-key"],
      setAppId: ["123456789"],
      enableFeature: ["multi", "drives"],
      setIncludeFolders: [true],
      setSelectFolderEnabled: [false],
    });

    // A second open reuses the loaded API: no second script tag.
    const again = openGoogleDrivePicker(session);
    await vi.waitFor(() => expect(google.calls.setVisible).toHaveLength(2));
    google.respond({ action: "cancel" });
    expect(await again).toEqual([]);
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
    expect(google.load).toHaveBeenCalledTimes(1);
  });

  it("rejects when the script fails, and tries again on the next open", async () => {
    const { openGoogleDrivePicker } = await import("./googlePicker");
    const failed = openGoogleDrivePicker(session);
    document.head.querySelector("script")!.dispatchEvent(new Event("error"));
    await expect(failed).rejects.toThrow();
    void openGoogleDrivePicker(session).catch(() => undefined);
    expect(document.head.querySelectorAll("script")).toHaveLength(2);
  });

  it("skips the script tag when gapi is already on the page", async () => {
    const google = fakeGoogle();
    window.gapi = { load: google.load };
    const { openGoogleDrivePicker } = await import("./googlePicker");
    const opened = openGoogleDrivePicker(session);
    await vi.waitFor(() => expect(google.calls.setVisible).toEqual([true]));
    expect(document.head.querySelector("script")).toBeNull();
    google.respond({ action: "cancel" });
    expect(await opened).toEqual([]);
  });

  it("rejects when the picker module fails to load, then retries the load", async () => {
    const google = fakeGoogle();
    const load = vi
      .fn()
      .mockImplementationOnce(
        (_api: string, options: { onerror: () => void }) => options.onerror(),
      )
      .mockImplementation(google.load);
    window.gapi = { load };
    const { openGoogleDrivePicker } = await import("./googlePicker");
    await expect(openGoogleDrivePicker(session)).rejects.toThrow(
      "The Google Picker could not be loaded.",
    );

    const opened = openGoogleDrivePicker(session);
    await vi.waitFor(() => expect(google.calls.setVisible).toEqual([true]));
    google.respond({ action: "cancel" });
    expect(await opened).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rejects when gapi reports the picker loaded but google.picker is missing", async () => {
    window.gapi = {
      load: (_api, options) => {
        window.google = {};
        options.callback();
      },
    };
    const { openGoogleDrivePicker } = await import("./googlePicker");
    await expect(openGoogleDrivePicker(session)).rejects.toThrow(
      "The Google Picker could not be loaded.",
    );
  });

  it("ignores intermediate picker events and treats a pick without documents as empty", async () => {
    const google = fakeGoogle();
    window.gapi = { load: google.load };
    const { openGoogleDrivePicker } = await import("./googlePicker");
    const opened = openGoogleDrivePicker(session);
    await vi.waitFor(() => expect(google.calls.setVisible).toEqual([true]));

    // Google also fires a "loaded" action when the dialog appears.
    google.respond({ action: "loaded" });
    const settled = vi.fn();
    void opened.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    google.respond({ action: "picked" });
    expect(await opened).toEqual([]);
  });
});
