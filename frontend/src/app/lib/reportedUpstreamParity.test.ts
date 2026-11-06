import { describe, expect, it } from "vitest";
import * as backend from "../../../../backend/src/lib/reportedUpstreamCodes";
import * as client from "@mike/client";

// The backend writes these codes and sentences into its 503 bodies; the web
// app and the Word add-in (packages/client) recognise the codes as "already
// reported server-side" and show the same sentences. A drift on either side
// would report the incident twice or show a sentence the server never sent.
describe("server-reported 5xx codes", () => {
    it.each([
        "UPSTREAM_UNAVAILABLE_CODE",
        "UPSTREAM_UNAVAILABLE_MESSAGE",
        "SCHEMA_OUT_OF_DATE_CODE",
        "SCHEMA_OUT_OF_DATE_MESSAGE",
    ] as const)("%s matches between backend/src/lib/reportedUpstreamCodes.ts and @mike/client", (name) => {
        expect(backend[name]).toBeTypeOf("string");
        expect(client[name]).toBe(backend[name]);
    });
});
