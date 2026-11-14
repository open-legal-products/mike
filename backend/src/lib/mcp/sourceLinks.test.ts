import { describe, expect, it } from "vitest";
import sec from "./__fixtures__/sec-source-presence.json";
import court from "./__fixtures__/ninth-circuit-source-presence.json";
import { extractCounterpediaSourceLinks as extract } from "./sourceLinks";

const TOOL = "counterpedia.get_source_presence";
const SEC_URL = "https://www.sec.gov/litigation/complaints/2018/comp-pr2018-41-theranos-holmes.pdf";
const COURT_URL = "https://cdn.ca9.uscourts.gov/datastore/opinions/2025/12/22/22-10312.pdf";
const wire = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], isError: false });
const call = (payload = sec, args = { source_id: payload.source_id }) => extract(TOOL, args, wire(payload));

describe("Source links from retained SEC/Ninth Circuit tool responses", () => {
    it("returns the exact recorded SEC discovery URL, title and Source identity", () => {
        expect(call()).toEqual([{ source_id: sec.source_id, label: sec.presence.identity.label, url: SEC_URL, basis: "discovery" }]);
    });
    it("accepts the Source-bound Ninth Circuit capture origin without claiming reader access", () => {
        expect(court.presence.reader_access.status).toBe("unavailable");
        expect(extract(TOOL, { source_id: court.source_id }, wire(court))).toEqual([
            { source_id: court.source_id, label: court.presence.identity.label, url: COURT_URL, basis: "capture_observation" },
        ]);
    });
    it("does not authorize the SEC model-invented comp18200.htm from a source list or prose", () => {
        const invented = "https://www.sec.gov/litigation/complaints/2018/comp18200.htm";
        expect(extract("counterpedia.sources", { record_id: "TH-S01" }, wire({ source_id: sec.source_id, url: invented }))).toEqual([]);
        expect(extract(TOOL, { source_id: sec.source_id }, wire({ model_claim: invented, presence: sec.presence }))).toEqual([]);
        expect(call()[0].url).not.toBe(invented);
    });
    it.each(["source_id", "schema", "identity", "private", "discovery binding", "discovery unavailable", "no documentary title"])("refuses a missing or contradictory %s", (field) => {
        const value = structuredClone(sec);
        if (field === "source_id") value.source_id = "TH-S09-SRC-0001";
        if (field === "schema") value.presence.schema_version = "unknown";
        if (field === "identity") value.presence.identity.source_id = "TH-S09-SRC-0001";
        if (field === "private") value.presence.identity.publication_status = "private";
        if (field === "discovery binding") value.presence.discovery.value[0].source_id = "TH-S09-SRC-0001";
        if (field === "discovery unavailable") value.presence.discovery.status = "unavailable";
        if (field === "no documentary title") value.presence.identity.label = "";
        expect(call(value, { source_id: sec.source_id })).toEqual([]);
    });
    it.each(["unavailable", "source_record", "resolution", "capture_association"])("refuses an unresolved court %s", (field) => {
        const value = structuredClone(court);
        const row = value.presence.custody_observations.value[0];
        if (field === "unavailable") value.presence.custody_observations.status = "unavailable";
        if (field === "source_record") row.source_record.cp_source_id = sec.source_id;
        if (field === "resolution") row.resolution = "UNRESOLVED";
        if (field === "capture_association") row.capture_association.identity_resolution.cp_source_id = sec.source_id;
        expect(extract(TOOL, { source_id: court.source_id }, wire(value))).toEqual([]);
    });
    it("rejects tool errors and conflicting structured/text payloads", () => {
        expect(extract(TOOL, { source_id: sec.source_id }, { ...wire(sec), isError: true })).toEqual([]);
        expect(extract(TOOL, { source_id: sec.source_id }, { ...wire(sec), structuredContent: court })).toEqual([]);
    });
    it.each(["javascript:alert(1)", "//www.sec.gov/source", "https://user:secret@www.sec.gov/source", "https://www.sec.gov/source?token=secret", "https://www.sec.gov/source#token", "http://127.0.0.1/source", "http://[::1]/source", "http://169.254.169.254/source", "https://localhost/source", "https://host.local/source", "https://metadata/source", " https://www.sec.gov/source", "https://www.sec.gov/\\source"])("rejects unsafe or private locator %s", (url) => {
        const value = structuredClone(sec);
        value.presence.discovery.value[0].locator = url;
        expect(call(value)).toEqual([]);
    });
    it("keeps exact URL bytes rather than normalizing a returned public original", () => {
        const value = structuredClone(sec);
        value.presence.discovery.value[0].locator = "https://www.sec.gov:443/source";
        expect(call(value)[0].url).toBe("https://www.sec.gov:443/source");
    });
    it("retains only a bounded witness and never arbitrary tool-result fields", () => {
        const value = { ...sec, private_result: "must not persist", arbitrary_url: "https://evil.example" };
        expect(JSON.stringify(call(value))).not.toMatch(/private_result|must not persist|evil/);
    });
});
