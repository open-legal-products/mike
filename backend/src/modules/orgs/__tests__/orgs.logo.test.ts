import { describe, expect, it } from "vitest";
import { MAX_ORG_LOGO_BYTES, parseOrgLogoDataUrl } from "../orgs.logo";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const dataUrl = (type: string, bytes: number[]) =>
    `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

describe("parseOrgLogoDataUrl", () => {
    it("accepts a PNG and keeps its type and bytes", () => {
        const bytes = [...PNG_SIGNATURE, 9, 8, 7];
        expect(parseOrgLogoDataUrl(dataUrl("image/png", bytes))).toEqual({
            ok: true,
            contentType: "image/png",
            base64: Buffer.from(bytes).toString("base64"),
        });
    });

    it("judges the file by what it begins with, not by what it claims to be", () => {
        // A JPEG labelled PNG, and markup labelled as an image.
        expect(
            parseOrgLogoDataUrl(dataUrl("image/png", [0xff, 0xd8, 0xff, 0xe0])),
        ).toMatchObject({ ok: false });
        expect(
            parseOrgLogoDataUrl(
                dataUrl("image/jpeg", [...Buffer.from("<html><script>")]),
            ),
        ).toMatchObject({ ok: false });
    });

    it.each([
        ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
        ["image/webp", [...Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBP")]],
    ])("accepts the explicit %s signature", (type, bytes) => {
        expect(parseOrgLogoDataUrl(dataUrl(type, bytes))).toEqual({
            ok: true,
            contentType: type,
            base64: Buffer.from(bytes).toString("base64"),
        });
        expect(parseOrgLogoDataUrl(dataUrl(type, PNG_SIGNATURE))).toMatchObject({ ok: false });
    });

    it.each(["constructor", "__proto__", "toString", "image/constructor", "image/svg+xml", "text/html"])(
        "rejects an unsupported type %s without dynamic dispatch",
        (type) => {
            expect(parseOrgLogoDataUrl(dataUrl(type, PNG_SIGNATURE))).toMatchObject({ ok: false });
        },
    );

    it("does not accept SVG, which is a document rather than a picture", () => {
        expect(
            parseOrgLogoDataUrl(
                dataUrl("image/svg+xml", [...Buffer.from("<svg></svg>")]),
            ),
        ).toMatchObject({ ok: false });
    });

    it("accepts an image exactly at the limit and refuses one byte more", () => {
        const atLimit = [
            ...PNG_SIGNATURE,
            ...new Array(MAX_ORG_LOGO_BYTES - PNG_SIGNATURE.length).fill(1),
        ];
        expect(parseOrgLogoDataUrl(dataUrl("image/png", atLimit))).toMatchObject(
            { ok: true },
        );
        expect(
            parseOrgLogoDataUrl(dataUrl("image/png", [...atLimit, 1])),
        ).toMatchObject({ ok: false, detail: expect.stringMatching(/too large/) });
    });

    it.each([undefined, null, 7, "", "data:image/png;base64,", "data:image/png,plain"])(
        "refuses %p",
        (value) => {
            expect(parseOrgLogoDataUrl(value)).toMatchObject({ ok: false });
        },
    );
});
