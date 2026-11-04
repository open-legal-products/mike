/**
 * The storage-PUT reporting rule shared by the web app and the Word add-in
 * (MIKE-FRONTEND-28, 3D, 2Z; MIKE-WORD-ADDIN-9). The end-to-end path (three
 * attempts, then one report) is pinned in
 * `frontend/src/app/lib/mikeApi.uploadSessions.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { classifyStorageTarget, storageFailureReport } from "./uploadSessionClient";

describe("classifyStorageTarget", () => {
    it.each([
        // The compose default R2_PUBLIC_ENDPOINT_URL opened from a real host.
        ["http://localhost:9000/mike/k?X-Amz-Signature=s", "https://mike.firm.example/projects", "loopback"],
        ["http://127.0.0.1:9000/mike/k", "http://192.168.1.20:3000/", "loopback"],
        // An https front end signing against an http public endpoint.
        ["http://storage.firm.example:9000/mike/k", "https://mike.firm.example/", "mixed_content"],
        ["https://bucket.r2.example/mike/k", "https://mike.firm.example/", "cross_origin"],
        // Local development: both on the developer's machine is not the fault.
        ["http://localhost:9000/mike/k", "http://localhost:3000/", "cross_origin"],
        ["/mike/k", "https://localhost:3200/taskpane.html", "same_origin"],
    ])("classifies %s from %s as %s", (uploadUrl, pageUrl, expected) => {
        expect(classifyStorageTarget(uploadUrl, pageUrl)).toBe(expected);
    });

    it("says nothing without a page or with an unparsable URL", () => {
        expect(classifyStorageTarget("http://localhost:9000/k", undefined)).toBeUndefined();
        expect(classifyStorageTarget("http://[bad", "https://mike.firm.example/")).toBeUndefined();
    });
});

describe("storageFailureReport", () => {
    it("pins every exhausted PUT to one issue and carries the target enum", () => {
        const network = storageFailureReport({ error: new TypeError("Failed to fetch"), network: true, target: "loopback" });
        const status = storageFailureReport({ error: new Error("Object storage returned 503"), status: 503, target: "cross_origin" });
        expect(network).toEqual({
            level: "warning",
            tags: {
                component: "mike-api",
                operation: "upload_session.storage",
                http_method: "PUT",
                network: true,
                storage_target: "loopback",
            },
            fingerprint: ["upload-storage-put"],
        });
        expect(status?.fingerprint).toEqual(network?.fingerprint);
        expect(status?.tags).toMatchObject({ http_status: 503, storage_target: "cross_origin" });
    });

    it.each([400, 404, 411, 413])("does not report a %i: the file or request, not the deployment", (code) => {
        expect(storageFailureReport({ error: new Error(), status: code })).toBeNull();
    });

    it("still reports a 403: a signed URL the store refuses is a deployment fault", () => {
        expect(storageFailureReport({ error: new Error(), status: 403 })).not.toBeNull();
    });
});
