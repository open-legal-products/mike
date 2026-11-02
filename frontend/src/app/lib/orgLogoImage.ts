// Preparing an image a person picked to be their organization's logo.
//
// The logo is shown small and square (18px in the sidebar), and most firm
// logos are neither: they are wide wordmarks. So the person frames it — pans
// and zooms the picture inside a square — and what they framed is drawn onto
// a small canvas and sent as a PNG. A photograph straight off a phone becomes
// a few kilobytes, and nothing but pixels is sent: no metadata, and no format
// the server does not take.

/** The types a logo may be picked from. SVG is not one: see the server. */
export const ORG_LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

const ACCEPTED_TYPES = ORG_LOGO_ACCEPT.split(",");

/** The side of the stored logo, in pixels. */
export const ORG_LOGO_OUTPUT_SIDE = 256;

/** The largest file that may be picked. */
export const ORG_LOGO_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The furthest the picture can be zoomed in, relative to filling the square. */
export const ORG_LOGO_MAX_ZOOM = 4;

export class OrgLogoImageError extends Error {}

/**
 * Whether a picked file can be a logo at all, before it is opened. Throws an
 * OrgLogoImageError whose message can be shown as it is.
 */
export function validateOrgLogoFile(file: File): void {
    if (!ACCEPTED_TYPES.includes(file.type))
        throw new OrgLogoImageError("Choose a PNG, JPEG or WebP image.");
    if (file.size > ORG_LOGO_MAX_FILE_BYTES)
        throw new OrgLogoImageError("Choose an image under 10 MB.");
}

/** How the picture is framed: its size, how far it is zoomed, and where. */
export interface OrgLogoFrame {
    imageWidth: number;
    imageHeight: number;
    /**
     * 1 fills the square with the picture's shorter side (nothing empty,
     * the longer side cropped). Below 1 shows more of the picture, down to
     * all of it; above 1 closes in.
     */
    zoom: number;
    /** The point of the picture at the square's centre, in image pixels. */
    centerX: number;
    centerY: number;
}

/** The least zoom: the whole picture inside the square. */
export function orgLogoMinZoom(imageWidth: number, imageHeight: number) {
    return (
        Math.min(imageWidth, imageHeight) / Math.max(imageWidth, imageHeight)
    );
}

/** A frame to start from: the picture filling the square, centred. */
export function initialOrgLogoFrame(
    imageWidth: number,
    imageHeight: number,
): OrgLogoFrame {
    return {
        imageWidth,
        imageHeight,
        zoom: 1,
        centerX: imageWidth / 2,
        centerY: imageHeight / 2,
    };
}

/**
 * Keep a frame inside what makes sense: zoom within its range, and the
 * picture never dragged off so far that the square shows empty space it
 * could have filled. Along an axis where the picture is narrower than the
 * square it sits centred.
 */
export function clampOrgLogoFrame(frame: OrgLogoFrame): OrgLogoFrame {
    const { imageWidth, imageHeight } = frame;
    const zoom = Math.min(
        ORG_LOGO_MAX_ZOOM,
        Math.max(orgLogoMinZoom(imageWidth, imageHeight), frame.zoom),
    );
    // The side of the square, measured in image pixels at this zoom.
    const visible = Math.min(imageWidth, imageHeight) / zoom;
    const along = (center: number, length: number) =>
        length <= visible
            ? length / 2
            : Math.min(length - visible / 2, Math.max(visible / 2, center));
    return {
        imageWidth,
        imageHeight,
        zoom,
        centerX: along(frame.centerX, imageWidth),
        centerY: along(frame.centerY, imageHeight),
    };
}

/**
 * Where the picture is drawn inside a square of `side` pixels so that the
 * frame is what the square shows. The same answer serves the large square
 * the person drags in, the small previews, and the canvas that is saved.
 */
export function orgLogoPlacement(frame: OrgLogoFrame, side: number) {
    const scale =
        (side / Math.min(frame.imageWidth, frame.imageHeight)) * frame.zoom;
    return {
        scale,
        left: side / 2 - frame.centerX * scale,
        top: side / 2 - frame.centerY * scale,
        width: frame.imageWidth * scale,
        height: frame.imageHeight * scale,
    };
}

/** Draw the framed picture and return it as the PNG data URL that is sent. */
export function renderOrgLogo(
    image: CanvasImageSource,
    frame: OrgLogoFrame,
): string {
    const canvas = document.createElement("canvas");
    canvas.width = ORG_LOGO_OUTPUT_SIDE;
    canvas.height = ORG_LOGO_OUTPUT_SIDE;
    const context = canvas.getContext("2d");
    if (!context)
        throw new OrgLogoImageError("That image could not be prepared.");
    const placement = orgLogoPlacement(frame, ORG_LOGO_OUTPUT_SIDE);
    // Whatever the picture does not cover stays transparent.
    context.clearRect(0, 0, ORG_LOGO_OUTPUT_SIDE, ORG_LOGO_OUTPUT_SIDE);
    context.imageSmoothingQuality = "high";
    context.drawImage(
        image,
        placement.left,
        placement.top,
        placement.width,
        placement.height,
    );
    return canvas.toDataURL("image/png");
}
