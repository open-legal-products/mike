import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ORG_LOGO_MAX_ZOOM,
    ORG_LOGO_OUTPUT_SIDE,
    OrgLogoImageError,
    clampOrgLogoFrame,
    initialOrgLogoFrame,
    orgLogoMinZoom,
    orgLogoPlacement,
    renderOrgLogo,
    validateOrgLogoFile,
} from "./orgLogoImage";

const file = (type: string, size = 10) =>
    new File([new Uint8Array(size)], "logo", { type });

afterEach(() => {
    vi.restoreAllMocks();
});

describe("validateOrgLogoFile", () => {
    it.each(["image/png", "image/jpeg", "image/webp"])("accepts %s", (type) => {
        expect(() => validateOrgLogoFile(file(type))).not.toThrow();
    });

    it.each(["image/svg+xml", "image/gif", "application/pdf", ""])(
        "refuses %p",
        (type) => {
            expect(() => validateOrgLogoFile(file(type))).toThrow(
                "Choose a PNG, JPEG or WebP image.",
            );
        },
    );

    it("refuses a file over the size limit, and accepts one at it", () => {
        const atLimit = file("image/png");
        Object.defineProperty(atLimit, "size", { value: 10 * 1024 * 1024 });
        expect(() => validateOrgLogoFile(atLimit)).not.toThrow();

        const over = file("image/png");
        Object.defineProperty(over, "size", { value: 10 * 1024 * 1024 + 1 });
        expect(() => validateOrgLogoFile(over)).toThrow(OrgLogoImageError);
        expect(() => validateOrgLogoFile(over)).toThrow(
            "Choose an image under 10 MB.",
        );
    });
});

describe("framing a logo", () => {
    // A wide wordmark: four times as wide as it is tall.
    const wide = initialOrgLogoFrame(800, 200);

    it("starts with the picture filling the square, centred", () => {
        expect(wide).toEqual({
            imageWidth: 800,
            imageHeight: 200,
            zoom: 1,
            centerX: 400,
            centerY: 100,
        });
        // The shorter side fills a 200px square exactly; the longer overflows.
        expect(orgLogoPlacement(wide, 200)).toEqual({
            scale: 1,
            left: -300,
            top: 0,
            width: 800,
            height: 200,
        });
    });

    it("can be zoomed out until the whole picture is inside the square, and no further", () => {
        expect(orgLogoMinZoom(800, 200)).toBe(0.25);
        const fitted = clampOrgLogoFrame({ ...wide, zoom: 0.01 });
        expect(fitted.zoom).toBe(0.25);
        // All 800px across now fit the 200px square, centred top to bottom.
        expect(orgLogoPlacement(fitted, 200)).toEqual({
            scale: 0.25,
            left: 0,
            top: 75,
            width: 200,
            height: 50,
        });
    });

    it("cannot be zoomed in past the limit", () => {
        expect(clampOrgLogoFrame({ ...wide, zoom: 99 }).zoom).toBe(
            ORG_LOGO_MAX_ZOOM,
        );
    });

    it("cannot be dragged so far that the square shows space the picture could fill", () => {
        // At zoom 1 the square shows 200 image pixels; its centre can go no
        // nearer an edge than half of that.
        expect(clampOrgLogoFrame({ ...wide, centerX: -500 }).centerX).toBe(100);
        expect(clampOrgLogoFrame({ ...wide, centerX: 5000 }).centerX).toBe(700);
        // Top to bottom there is nothing to pan: the picture is exactly as
        // tall as the square.
        expect(clampOrgLogoFrame({ ...wide, centerY: 0 }).centerY).toBe(100);
    });

    it("re-centres an axis that no longer overflows once zoomed out", () => {
        const dragged = clampOrgLogoFrame({ ...wide, centerX: 700 });
        expect(dragged.centerX).toBe(700);
        // Fully zoomed out, the whole width is visible: nowhere to be but
        // the middle.
        expect(clampOrgLogoFrame({ ...dragged, zoom: 0.25 }).centerX).toBe(400);
    });

    it("places the picture the same way at any size of square", () => {
        const frame = clampOrgLogoFrame({ ...wide, zoom: 2, centerX: 300 });
        const large = orgLogoPlacement(frame, 240);
        const small = orgLogoPlacement(frame, 18);
        for (const key of ["left", "top", "width", "height"] as const)
            expect(small[key] / large[key]).toBeCloseTo(18 / 240);
    });

    it("treats a tall picture the same way round", () => {
        const tall = initialOrgLogoFrame(100, 400);
        expect(orgLogoPlacement(tall, 100)).toMatchObject({
            left: 0,
            top: -150,
            width: 100,
            height: 400,
        });
        expect(clampOrgLogoFrame({ ...tall, centerY: 0 }).centerY).toBe(50);
    });
});

describe("renderOrgLogo", () => {
    it("draws what was framed onto a square canvas and returns a PNG", () => {
        const drawImage = vi.fn();
        const clearRect = vi.fn();
        const canvas = {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage, clearRect }),
            toDataURL: vi.fn(() => "data:image/png;base64,AAAA"),
        };
        vi.spyOn(document, "createElement").mockReturnValue(canvas as never);
        const image = {} as CanvasImageSource;
        const frame = initialOrgLogoFrame(800, 200);

        expect(renderOrgLogo(image, frame)).toBe("data:image/png;base64,AAAA");

        expect([canvas.width, canvas.height]).toEqual([
            ORG_LOGO_OUTPUT_SIDE,
            ORG_LOGO_OUTPUT_SIDE,
        ]);
        // The 200px-tall picture fills the 256px square: scaled by 1.28.
        expect(drawImage).toHaveBeenCalledWith(image, -384, 0, 1024, 256);
        expect(canvas.toDataURL).toHaveBeenCalledWith("image/png");
    });

    it("says so when the browser cannot draw", () => {
        vi.spyOn(document, "createElement").mockReturnValue({
            getContext: () => null,
        } as never);
        expect(() =>
            renderOrgLogo({} as CanvasImageSource, initialOrgLogoFrame(10, 10)),
        ).toThrow(OrgLogoImageError);
    });
});
