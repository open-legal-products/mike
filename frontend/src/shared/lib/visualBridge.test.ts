import { describe, expect, it } from "vitest";
import {
    buildVisualHostDocument,
    parseVisualMessage,
    withVisualTheme,
} from "./visualBridge";

const uuid = "4f1b7e8a-2c3d-4e5f-8a9b-0c1d2e3f4a5b";

describe("visualBridge", () => {
    it("accepts only the kit's messages, caps every string and requires a uuid or active cite", () => {
        expect(parseVisualMessage({ type: "mike:ready", extra: 1 })).toEqual({ type: "mike:ready" });
        expect(parseVisualMessage({ type: "mike:error" })).toEqual({ type: "mike:error" });
        expect(
            parseVisualMessage({
                type: "mike:cite",
                cite: uuid,
                citeVersion: uuid.replace(/-/g, ""),
                quote: "the quoted clause",
                page: "3",
                sheet: "Rent",
                cell: "B7",
                clause: "4.2",
                onclick: "alert(1)",
            }),
        ).toEqual({
            type: "mike:cite",
            cite: {
                cite: uuid,
                version: uuid.replace(/-/g, ""),
                quote: "the quoted clause",
                page: "3",
                sheet: "Rent",
                cell: "B7",
                clause: "4.2",
            },
        });
        expect(parseVisualMessage({ type: "mike:cite", cite: "active" })).toEqual({
            type: "mike:cite",
            cite: { cite: "active" },
        });
        expect(parseVisualMessage({ type: "mike:cite", cite: "javascript:alert(1)" })).toBeNull();
        expect(parseVisualMessage({ type: "mike:cite", cite: uuid, quote: "x".repeat(4001) })).toBeNull();
        expect(parseVisualMessage({ type: "mike:cite", cite: uuid, page: 3 })).toBeNull();
        expect(parseVisualMessage({ type: "mike:open", cite: uuid })).toBeNull();
        expect(parseVisualMessage("mike:ready")).toBeNull();
        expect(parseVisualMessage(null)).toBeNull();
        expect(withVisualTheme('<!doctype html><html lang="en" data-theme="light"><body></body></html>', "dark")).toBe(
            '<!doctype html><html data-theme="dark" lang="en"><body></body></html>',
        );
    });

    it("escapes the visual into a host document whose csp comes first and whose inner frame only allows scripts", () => {
        const visual = '<html><body onload="x()"><p>A & B "quoted"</p><script>fetch("https://evil.example")</script></body></html>';
        const host = buildVisualHostDocument(visual, 'Rent <"chart">');

        expect(host.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
        expect(host).toContain("frame-src 'none'");
        expect(host).toContain('<title>Rent &lt;"chart"&gt;</title>');
        const frame = host.slice(host.indexOf("<iframe"), host.indexOf("</iframe>"));
        expect(frame).toContain('sandbox="allow-scripts"');
        expect(frame).not.toContain("allow-same-origin");
        expect(frame).toContain("&quot;quoted&quot;");
        expect(frame).toContain("A &amp; B");
        expect(frame).not.toContain('<script>fetch("https://evil.example")</script>');
    });
});
