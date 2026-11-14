import { describe, expect, it } from "vitest";
import { parseMcpSourceLinks } from "./mcpSourceLinks";
const url = "https://cdn.ca9.uscourts.gov/datastore/opinions/2025/12/22/22-10312.pdf";
const witness = { source_id: "TH-S09-SRC-0001", label: "Ninth Circuit Order and Amended Opinion (captured public document)", url, basis: "capture_observation" };
describe("Source-link wire/history validation", () => {
    it("keeps the Source/URL pair and exact returned URL bytes", () => {
        expect(parseMcpSourceLinks([witness])).toEqual([witness]);
        expect(parseMcpSourceLinks([{ ...witness, url: "https://www.sec.gov:443/source" }])[0].url).toBe("https://www.sec.gov:443/source");
    });
    it.each(["javascript:alert(1)", "//evil.example", "/sources/guessed", "https://u:p@www.sec.gov/x", "https://www.sec.gov/x?secret=1", "https://www.sec.gov/x#token", "http://127.1/x", "http://[::1]/x", "https://localhost/x", "https://host.local/x", "https://host.internal/x", "https://metadata/x", " https://www.sec.gov/x", "https://www.sec.gov/\\x"])("refuses unsafe or private URL %s", (value) => {
        expect(parseMcpSourceLinks([{ ...witness, url: value }])).toEqual([]);
    });
    it("refuses absent, oversized or untyped data", () => {
        for (const value of [null, {}, "model claim", [{ ...witness, source_id: "" }], [{ ...witness, label: "x".repeat(241) }], [{ ...witness, basis: "model" }]]) expect(parseMcpSourceLinks(value)).toEqual([]);
        expect(parseMcpSourceLinks(Array(10).fill(witness))).toHaveLength(4);
    });
});
