import { describe, expect, it } from "vitest";
import { MikeApiError, SCHEMA_OUT_OF_DATE_MESSAGE, UPSTREAM_UNAVAILABLE_MESSAGE } from "./mikeApi";
import {
    errorCode,
    knownErrorCodeMessage,
    userFacingApiError,
} from "./userFacingError";

describe("userFacingApiError", () => {
    it("allows intentional client-error details", () => {
        const error = new MikeApiError({
            status: 400,
            message: "The filename is required.",
        });

        expect(userFacingApiError(error, "Fallback")).toBe(
            "The filename is required.",
        );
    });

    it("shows the intentional schema_out_of_date and upstream_unavailable messages despite the 5xx status", () => {
        const error = new MikeApiError({
            status: 503,
            code: "schema_out_of_date",
            message: SCHEMA_OUT_OF_DATE_MESSAGE,
        });
        expect(userFacingApiError(error, "Fallback")).toBe(SCHEMA_OUT_OF_DATE_MESSAGE);
        expect(
            userFacingApiError(
                new MikeApiError({ status: 503, code: "upstream_unavailable", message: "raw" }),
                "Fallback",
            ),
        ).toBe(UPSTREAM_UNAVAILABLE_MESSAGE);
        // Any other 5xx code keeps the generic fallback.
        expect(
            userFacingApiError(
                new MikeApiError({ status: 503, code: "internal_error", message: "x" }),
                "Fallback",
            ),
        ).toBe("Fallback");
    });

    it("does not expose server or plain exception messages", () => {
        expect(
            userFacingApiError(
                new MikeApiError({
                    status: 500,
                    message: "relation user_profiles does not exist",
                }),
                "Please try again.",
            ),
        ).toBe("Please try again.");
        expect(
            userFacingApiError(
                new Error("getaddrinfo ENOTFOUND internal-db"),
                "Please try again.",
            ),
        ).toBe("Please try again.");
    });

    it("rejects non-client statuses and empty client-error messages", () => {
        expect(
            userFacingApiError(
                new MikeApiError({ status: 399, message: "Unexpected" }),
                "Fallback",
            ),
        ).toBe("Fallback");
        expect(
            userFacingApiError(
                new MikeApiError({ status: 400, message: "" }),
                "Fallback",
            ),
        ).toBe("Fallback");
    });
});

describe("errorCode", () => {
    it("returns null for values without a string code", () => {
        expect(errorCode(null)).toBeNull();
        expect(errorCode("invalid_credentials")).toBeNull();
        expect(errorCode({})).toBeNull();
        expect(errorCode({ code: 403 })).toBeNull();
    });
});

describe("knownErrorCodeMessage", () => {
    it("maps allowlisted codes and hides unknown ones", () => {
        const messages = { invalid_credentials: "Incorrect credentials." };
        expect(
            knownErrorCodeMessage(
                { code: "invalid_credentials" },
                messages,
                "Unable to log in.",
            ),
        ).toBe("Incorrect credentials.");
        expect(
            knownErrorCodeMessage(
                { code: "internal_provider_error" },
                messages,
                "Unable to log in.",
            ),
        ).toBe("Unable to log in.");
    });

    it("uses the fallback when no error code is available", () => {
        expect(
            knownErrorCodeMessage(
                new Error("provider failed"),
                { invalid_credentials: "Incorrect credentials." },
                "Unable to log in.",
            ),
        ).toBe("Unable to log in.");
    });
});
