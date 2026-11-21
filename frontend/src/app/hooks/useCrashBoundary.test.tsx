import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCrashBoundary } from "./useCrashBoundary";

const reporting = vi.hoisted(() => ({
    reportError: vi.fn(),
    isReported: vi.fn(() => false),
}));
vi.mock("@/app/lib/errorReporting", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/errorReporting")>()),
    ...reporting,
}));

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

describe("useCrashBoundary", () => {
    it("reports the crash once with its component, and the operation when the boundary knows it", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const error = Object.assign(new Error("render exploded"), { digest: "abc123" });

        const { result, rerender } = renderHook(() =>
            useCrashBoundary(error, {
                component: "route-error-boundary",
                operation: "documents.open",
            }),
        );
        rerender();

        expect(reporting.reportError).toHaveBeenCalledTimes(1);
        expect(reporting.reportError).toHaveBeenCalledWith(error, {
            tags: {
                component: "route-error-boundary",
                operation: "documents.open",
                digest: "abc123",
            },
        });
        expect(result.current).toMatch(/^mailto:/);
        expect(result.current).not.toContain("render exploded");
    });

    it("leaves a crash the API client already reported alone", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        reporting.isReported.mockReturnValue(true);

        renderHook(() =>
            useCrashBoundary(new Error("x"), { component: "global-error-boundary", level: "fatal" }),
        );

        expect(reporting.reportError).not.toHaveBeenCalled();
    });
});
