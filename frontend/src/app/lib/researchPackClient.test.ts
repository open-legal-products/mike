// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyResearchPackFile } from "./researchPackClient";

const fixture = readFileSync(
    resolve(
        process.cwd(),
        "../tests/fixtures/research-workspace-portable-v02/public-evidence-r2.research-pack.json",
    ),
);
describe("research pack browser adapter", () => {
    it("verifies the actual fixture and retains the original file", async () => {
        vi.stubGlobal("window", { location: { hostname: "127.0.0.1" } });
        const digest = Array.from(
            new Uint8Array(
                await crypto.subtle.digest(
                    "SHA-256",
                    fixture.buffer.slice(
                        fixture.byteOffset,
                        fixture.byteOffset + fixture.byteLength,
                    ) as ArrayBuffer,
                ),
            ),
            (v) => v.toString(16).padStart(2, "0"),
        ).join("");
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ integrity: "pass", input_sha256: digest }), {
                    status: 200,
                }),
            ),
        );
        const file = new File([fixture], "public-evidence-r2.research-pack.json", {
            type: "application/json",
        });
        const result = await verifyResearchPackFile(file);
        expect(result.file).toBe(file);
        expect(result.pack.revisions).toHaveLength(2);
        vi.unstubAllGlobals();
    });
    it("refuses a verifier digest mismatch", async () => {
        vi.stubGlobal("window", { location: { hostname: "127.0.0.1" } });
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ integrity: "pass", input_sha256: "wrong" }), {
                    status: 200,
                }),
            ),
        );
        await expect(verifyResearchPackFile(new File([fixture], "pack.json"))).rejects.toThrow(
            "did not match",
        );
        vi.unstubAllGlobals();
    });
});
