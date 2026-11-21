/**
 * The Word add-in's session start outside an Office host.
 *
 * Fail-without-fix: `initialize()` removed two legacy keys through the
 * `OfficeRuntime` global. Where Office did not inject it (taskpane.html in a
 * plain browser tab, or a Word host without that storage API) the
 * ReferenceError was thrown before the `.catch(() => {})` existed, rejected
 * the whole sign-in chain, and was filed to Sentry as "Failure in
 * word.session / notify" (MIKE-WORD-ADDIN-7) while the pane said "Mike
 * couldn't sign you in".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/react", () => ({
    isEnabled: () => true,
    init: vi.fn(),
    captureException: vi.fn(() => "exc-1"),
    captureMessage: vi.fn(() => "msg-1"),
    setUser: vi.fn(),
    getCurrentScope: vi.fn(),
    captureConsoleIntegration: vi.fn(() => ({ name: "CaptureConsole" })),
    ErrorBoundary: () => null,
    withScope: (cb: (scope: unknown) => unknown) =>
        cb({ setLevel: vi.fn(), setTag: vi.fn(), setExtra: vi.fn(), setFingerprint: vi.fn() }),
}));

import * as Sentry from "@sentry/react";
import {
    getSessionState,
    initialize,
    subscribe,
} from "../../../word-addin/src/taskpane/auth/session";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("initialize without the OfficeRuntime global", () => {
    it("asks the backend for the session and reports nothing", async () => {
        expect("OfficeRuntime" in globalThis).toBe(false);
        const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
        vi.stubGlobal("fetch", fetchMock);
        const settled = new Promise<void>((resolve) => {
            subscribe(() => {
                if (!getSessionState().loading) resolve();
            });
        });

        expect(() => initialize()).not.toThrow();
        await settled;

        expect(Sentry.captureException).not.toHaveBeenCalled();
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
        expect(getSessionState()).toEqual({ user: null, loading: false, error: null });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
