import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyResearchPack } from "./researchPack.service";

const fixture = readFileSync(
    resolve(
        process.cwd(),
        "../tests/fixtures/research-workspace-portable-v02/public-evidence-r2.research-pack.json",
    ),
);

describe("research pack backend verification", () => {
    it("verifies the pinned fixture through the bounded Python bridge", async () => {
        const report = await verifyResearchPack(fixture);
        expect(report.schema).toBe("arcs.verify.research_workspace_report.v0.1");
        expect(report.integrity).toBe("pass");
        expect(report.authenticity).toBe("not_established");
        expect(report.input_sha256).toBe(
            "ef847d65f5afb38996d537f5bfb305b71cc25fe609427bf32c3c722f9c09c41b",
        );
    });

    it("refuses malformed bytes without persistence", async () => {
        const report = await verifyResearchPack(Buffer.from("{}"));
        expect(report.integrity).toBe("fail");
        expect(report.failures).toEqual(expect.any(Array));
    });

    it("rejects input beyond the contract limit before spawning Python", async () => {
        await expect(verifyResearchPack(Buffer.alloc(4 * 1024 * 1024 + 1))).rejects.toThrow(
            "research_pack_too_large",
        );
    });
});
