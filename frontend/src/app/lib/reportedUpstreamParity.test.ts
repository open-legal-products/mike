import { describe, expect, expectTypeOf, it } from "vitest";
import type { ReportingOwner } from "@mike/contracts";
import * as backend from "../../../../backend/src/lib/reportedUpstreamCodes";
import * as client from "@mike/client";

// The backend writes these codes and sentences into its 503 bodies; the web
// app and the Word add-in show the same sentences. Reporting ownership is
// carried separately in the response, never inferred from these codes.
describe("server-reported 5xx codes", () => {
    it("keeps both runtime constants aligned with the wire type", () => {
        expectTypeOf<typeof backend.BACKEND_REPORTING_OWNER>().toEqualTypeOf<ReportingOwner>();
        expectTypeOf<typeof client.BACKEND_REPORTING_OWNER>().toEqualTypeOf<ReportingOwner>();
    });
    it.each([
        "BACKEND_REPORTING_OWNER",
        "UPSTREAM_UNAVAILABLE_CODE",
        "UPSTREAM_UNAVAILABLE_MESSAGE",
        "SCHEMA_OUT_OF_DATE_CODE",
        "SCHEMA_OUT_OF_DATE_MESSAGE",
    ] as const)("%s matches between backend/src/lib/reportedUpstreamCodes.ts and @mike/client", (name) => {
        expect(backend[name]).toBeTypeOf("string");
        expect(client[name]).toBe(backend[name]);
    });
});
