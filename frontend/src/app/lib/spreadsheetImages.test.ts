import { describe, expect, it } from "vitest";
import { normalizeSpreadsheetImages } from "./spreadsheetImages";

describe("normalizeSpreadsheetImages", () => {
    it.each([undefined, null, {}, "invalid"])(
        "handles absent or empty image collections: %s",
        (images) => {
            expect(normalizeSpreadsheetImages(images)).toEqual([]);
        },
    );

    it("converts keyed LuckyExcel images with their source, placement, and dimensions", () => {
        const images = {
            logo: {
                src: "data:image/png;base64,logo",
                originWidth: 400,
                originHeight: 200,
                default: { left: 85, top: 30, width: 180, height: 90 },
            },
            chart: {
                src: "data:image/png;base64,chart",
                originWidth: 240,
                originHeight: 120,
            },
        };
        expect(normalizeSpreadsheetImages(images)).toEqual([
            {
                id: "spreadsheet-image-logo",
                src: images.logo.src,
                left: 85,
                top: 30,
                width: 180,
                height: 90,
            },
            {
                id: "spreadsheet-image-chart",
                src: images.chart.src,
                left: 0,
                top: 0,
                width: 240,
                height: 120,
            },
        ]);
        expect(images.logo.default).toEqual({
            left: 85,
            top: 30,
            width: 180,
            height: 90,
        });
    });

    it("preserves compatible arrays, including cached workbook images", () => {
        const images = [
            {
                id: "logo",
                src: "logo",
                left: 5,
                top: 10,
                width: 100,
                height: 50,
            },
        ];
        expect(normalizeSpreadsheetImages(images)).toBe(images);
        expect(normalizeSpreadsheetImages({ logo: images[0] })).toEqual(images);
    });

    it.each([
        null,
        "invalid",
        {},
        { src: "" },
        { src: 1 },
        { src: "image", width: "100", height: 50 },
        { src: "image", width: NaN, height: 50 },
        { src: "image", width: 100 },
        { src: "image", width: 100, height: Infinity },
    ])(
        "omits invalid images without preventing the workbook from opening: %j",
        (image) => {
            expect(normalizeSpreadsheetImages({ image })).toEqual([]);
        },
    );
});
