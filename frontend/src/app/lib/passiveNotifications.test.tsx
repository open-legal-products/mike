import { afterEach, describe, expect, it, vi } from "vitest";
import { clearToasts, getSnapshot } from "@/shared/lib/toastStore";
import { notifyError, notifyInfo, notifySuccess } from "./userFacingError";
import { notifyError as notifyWordError } from "../../../../word-addin/src/taskpane/lib/notify";

const reporting = vi.hoisted(() => ({ reportError: vi.fn(), isReported: vi.fn(() => false) }));
vi.mock("./errorReporting", () => reporting);

afterEach(() => { clearToasts(); vi.clearAllMocks(); });

describe("passive notification boundary", () => {
    it.each([notifyError, notifyWordError])("never adds recovery or navigation actions", (notify) => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        for (const status of [401, 403, 409, 500]) {
            notify({ status, message: "A safe client error" });
            const toast = getSnapshot().at(-1)!;
            expect(toast.actions ?? []).toEqual([]);
            expect(toast.supportHref).toBeUndefined();
        }
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it("reports unexpected failures once and hides internal details", () => {
        const error = new Error("secret database detail");
        notifyError(error);
        expect(reporting.reportError).toHaveBeenCalledTimes(1);
        expect(getSnapshot()[0].message).not.toContain("secret");
        reporting.isReported.mockReturnValueOnce(true);
        notifyError(error);
        expect(reporting.reportError).toHaveBeenCalledTimes(1);
    });

    it("does not report validation or cancellation as incidents", () => {
        notifyError({ status: 400, message: "Choose a file." });
        notifyError(new DOMException("Cancelled", "AbortError"));
        expect(reporting.reportError).not.toHaveBeenCalled();
        expect(getSnapshot()).toHaveLength(1);
    });
});

it("shows passive success and informational notices", () => {
    notifySuccess("Saved", "Document");
    notifyInfo("Connection restored");
    expect(getSnapshot().map(({ tone, message }) => ({ tone, message }))).toEqual([
        { tone: "success", message: "Saved" },
        { tone: "info", message: "Connection restored" },
    ]);
});
