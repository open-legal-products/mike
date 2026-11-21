import { describe, expect, it } from "vitest";
import {
    SCHEMA_OUT_OF_DATE_MESSAGE,
    UPSTREAM_UNAVAILABLE_MESSAGE,
    reportedUpstreamMessage,
} from "./reportedUpstream";

describe("reportedUpstreamMessage", () => {
    it("names the sentence for each code the server side already reported", () => {
        expect(reportedUpstreamMessage("upstream_unavailable")).toBe(UPSTREAM_UNAVAILABLE_MESSAGE);
        expect(reportedUpstreamMessage("schema_out_of_date")).toBe(SCHEMA_OUT_OF_DATE_MESSAGE);
    });

    it.each(["internal_error", "toString", "", null, undefined])(
        "is null for %o, which a client still reports",
        (code) => {
            expect(reportedUpstreamMessage(code)).toBeNull();
        },
    );
});
