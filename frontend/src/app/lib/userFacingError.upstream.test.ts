import { afterEach, describe, expect, it, vi } from "vitest";
import { clearToasts, getSnapshot } from "@/shared/lib/toastStore";
import {
    MikeApiError,
    SCHEMA_OUT_OF_DATE_MESSAGE,
    UPSTREAM_UNAVAILABLE_MESSAGE,
} from "./mikeApi";
import { notifyError } from "./userFacingError";

const reporting = vi.hoisted(() => ({ reportError: vi.fn(), isReported: vi.fn(() => false) }));
vi.mock("./errorReporting", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./errorReporting")>()),
    ...reporting,
}));

afterEach(() => {
    clearToasts();
    vi.clearAllMocks();
});

describe("notifyError for server-reported 5xx codes", () => {
    it.each([
        ["schema_out_of_date", SCHEMA_OUT_OF_DATE_MESSAGE],
        ["upstream_unavailable", UPSTREAM_UNAVAILABLE_MESSAGE],
    ])("shows mikeApi's sentence for %s and does not report it again", (code, message) => {
        notifyError(new MikeApiError({ status: 503, code, message }));

        expect(getSnapshot().at(-1)?.message).toBe(message);
        expect(reporting.reportError).not.toHaveBeenCalled();
    });

    it("handles a thrown value that is not an object", () => {
        notifyError("plain string failure");

        expect(getSnapshot().at(-1)?.message).not.toContain("plain string");
    });

    it("lets a call site's own code message win", () => {
        notifyError(
            new MikeApiError({ status: 503, code: "schema_out_of_date", message: "x" }),
            { codeMessages: { schema_out_of_date: "Ask your admin to run the migration." } },
        );

        expect(getSnapshot().at(-1)?.message).toBe("Ask your admin to run the migration.");
    });

    it("leaves other 5xx codes on the generic classification", () => {
        notifyError(new MikeApiError({ status: 503, code: "internal_error", message: "secret" }));

        expect(getSnapshot().at(-1)?.message).not.toContain("secret");
        expect(getSnapshot().at(-1)?.message).not.toBe(UPSTREAM_UNAVAILABLE_MESSAGE);
    });
});
