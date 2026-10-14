"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Modal } from "@/app/components/modals/Modal";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
  ORG_LOGO_MAX_ZOOM,
  ORG_LOGO_MAX_FILE_BYTES,
  clampOrgLogoFrame,
  initialOrgLogoFrame,
  orgLogoMinZoom,
  orgLogoPlacement,
  renderOrgLogo,
  validateOrgLogoFile,
  type OrgLogoFrame,
} from "@/app/lib/orgLogoImage";

// Shared image framing for organization logos and user profile photos.
//
// The logo is shown small and square, and most logos are neither. Here the
// person frames it — drags the picture inside a square, zooms in on the part
// that reads at a small size, or zooms out to keep all of it — and sees it at
// the size it will be in the sidebar, beside the organization's name, before
// it changes for everybody.

/** The side of the square the picture is framed in, in pixels. */
const FRAME_SIDE = 224;
/** The size the logo is drawn at in the sidebar. */
const SIDEBAR_SIDE = 18;
/** How far an arrow key moves the picture, in pixels of the square. */
const NUDGE = 8;

/** The picture as the frame shows it, in a square of any size. */
function FramedLogo({
  image,
  frame,
  side,
  className,
}: {
  image: ImageBitmap;
  frame: OrgLogoFrame;
  side: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(side * ratio);
    canvas.height = Math.round(side * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, side, side);
    context.imageSmoothingQuality = "high";
    const placement = orgLogoPlacement(frame, side);
    context.drawImage(image, placement.left, placement.top, placement.width, placement.height);
  }, [frame, image, side]);
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none block shrink-0 ${className ?? ""}`}
      style={{ width: side, height: side }}
    />
  );
}

/**
 * Decodes and frames a selected raster image with drag, keyboard, and zoom controls.
 * Shows a logo or circular photo preview and emits the cropped data URL only on Save.
 */
export function ImageCropModal({
  file,
  imageUrl,
  name,
  variant = "logo",
  saving = false,
  removing = false,
  error,
  onCancel,
  onSave,
  onRemove,
}: {
  /** The picked image, already checked for type and size. */
  file?: File;
  /** The previously saved raster image, reopened without requiring another upload. */
  imageUrl?: string | null;
  name: string;
  variant?: "logo" | "photo";
  saving?: boolean;
  removing?: boolean;
  error?: string | null;
  onCancel: () => void;
  /** Called with the framed logo as a PNG data URL. */
  onSave: (dataUrl: string) => void;
  onRemove?: () => void;
}) {
  // Decode the upload into pixels before displaying it. The raw file never
  // becomes a DOM URL, so markup cannot be interpreted as preview content.
  const source = file ?? imageUrl ?? null;
  const busy = saving || removing;
  const [loaded, setLoaded] = useState<{
    source: File | string;
    image: ImageBitmap;
    frame: OrgLogoFrame;
  } | null>(null);
  const [failedSource, setFailedSource] = useState<File | string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let bitmap: ImageBitmap | undefined;
    /** Validates and decodes this file, discarding late results and releasing bitmaps after cancellation. */
    async function decode() {
      try {
        if (!source) return;
        // Stored images are bounded raster data URLs, never external URLs.
        let picked: File;
        if (typeof source === "string") {
          // Bound allocation before decoding or creating a File.
          if (source.length > Math.ceil(ORG_LOGO_MAX_FILE_BYTES / 3) * 4 + 32) throw new Error("Image too large");
          const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(source);
          if (!match) throw new Error("Unsupported image");
          const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
          picked = new File([bytes], "saved-image", { type: match[1] });
        } else picked = source;
        validateOrgLogoFile(picked);
        const image = await createImageBitmap(picked);
        if (cancelled) {
          image.close();
          return;
        }
        bitmap = image;
        if (image.width <= 0 || image.height <= 0) {
          image.close();
          bitmap = undefined;
          setFailedSource(source);
          return;
        }
        setLoaded({ source, image, frame: initialOrgLogoFrame(image.width, image.height) });
      } catch {
        if (!cancelled) setFailedSource(source);
      }
    }
    void decode();
    return () => {
      cancelled = true;
      bitmap?.close();
    };
  }, [source]);

  const isPhoto = variant === "photo";
  const previewSide = isPhoto ? 20 : SIDEBAR_SIDE;
  const [saveError, setSaveError] = useState(false);
  const image = loaded?.source === source ? loaded.image : null;
  const frame = loaded?.source === source ? loaded.frame : null;
  const unreadable = source ? failedSource === source : imageUrl === null;
  const changed = !!frame && (typeof source !== "string" || frame.zoom !== 1 ||
    frame.centerX !== frame.imageWidth / 2 || frame.centerY !== frame.imageHeight / 2);
  const drag = useRef<{ x: number; y: number } | null>(null);

  /** Applies a crop update only to the active file and clamps its zoom and position to the variant bounds. */
  const change = (next: (current: OrgLogoFrame) => OrgLogoFrame) =>
    setLoaded((current) => {
      if (!current || current.source !== source || busy) return current;
      const frame = next(current.frame);
      return { ...current, frame: clampOrgLogoFrame({
        ...frame, zoom: Math.max(isPhoto ? 1 : 0, frame.zoom),
      }) };
    });

  /** Move the picture by a distance measured in the framing square. */
  const moveBy = (dx: number, dy: number) =>
    change((current) => {
      const { scale } = orgLogoPlacement(current, FRAME_SIDE);
      return {
        ...current,
        centerX: current.centerX - dx / scale,
        centerY: current.centerY - dy / scale,
      };
    });

  /** Captures the pointer and starts a drag only when an editable image frame is available. */
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!frame || busy) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY };
  }
  /** Moves the crop by the pointer delta during an active drag, ignoring input while saving. */
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || busy) return;
    moveBy(event.clientX - drag.current.x, event.clientY - drag.current.y);
    drag.current = { x: event.clientX, y: event.clientY };
  }
  /** Clears drag state so subsequent pointer movement cannot shift the crop. */
  function endDrag() {
    drag.current = null;
  }
  /** Nudges the crop with arrow keys and prevents page scrolling for handled keys. */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // An arrow key moves the picture that way, as dragging it would.
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-NUDGE, 0],
      ArrowRight: [NUDGE, 0],
      ArrowUp: [0, -NUDGE],
      ArrowDown: [0, NUDGE],
    };
    const move = moves[event.key];
    if (!move || busy) return;
    event.preventDefault();
    moveBy(...move);
  }

  const minZoom = frame
    ? isPhoto ? 1 : orgLogoMinZoom(frame.imageWidth, frame.imageHeight)
    : 1;

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onCancel();
      }}
      breadcrumbs={[isPhoto ? "Account" : name, isPhoto ? "Profile photo" : "Logo"]}
      size="sm"
      className="h-auto max-h-[calc(100vh-2rem)]"
      primaryAction={{
        label: saving ? "Saving..." : "Save",
        variant: "blue",
        disabled: !frame || !changed || busy,
        onClick: () => {
          if (!frame || !image || !changed || busy) return;
          try {
            setSaveError(false);
            onSave(renderOrgLogo(image, frame));
          } catch {
            setSaveError(true);
          }
        },
      }}
      secondaryAction={onRemove ? {
        label: removing ? "Removing..." : "Remove",
        variant: "danger",
        disabled: busy,
        onClick: onRemove,
      } : undefined}
    >
      <div
        data-modal-scroll="vertical"
        className="min-h-0 min-w-0 space-y-5 overflow-y-auto pb-4"
      >
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
        {saveError ? <p role="alert" className="text-sm text-red-600">That image could not be prepared. Choose another.</p> : null}
        {unreadable ? (
          <p role="alert" className="text-sm text-red-600">
            That file could not be read as an image. Choose another.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <FieldLabel as="p">Position</FieldLabel>
              <div className="flex justify-center">
                <div
                  role="group"
                  tabIndex={0}
                  aria-label={`${isPhoto ? "Photo" : "Logo"} position. Drag, or use the arrow keys, to move the image.`}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onKeyDown={onKeyDown}
                  className={`touch-none ${isPhoto ? "rounded-full" : "rounded-2xl"} bg-gray-100 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 ${
                    frame ? "cursor-grab active:cursor-grabbing" : ""
                  }`}
                  style={{ width: FRAME_SIDE, height: FRAME_SIDE }}
                >
                  {frame && image ? (
                    <FramedLogo
                      image={image}
                      frame={frame}
                      side={FRAME_SIDE}
                      className={isPhoto ? "rounded-full" : "rounded-2xl"}
                    />
                  ) : (
                    <span className="block h-full w-full animate-pulse rounded-2xl bg-gray-200" />
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <FieldLabel htmlFor="organization-logo-zoom">Zoom</FieldLabel>
              <input
                id="organization-logo-zoom"
                type="range"
                min={minZoom}
                max={ORG_LOGO_MAX_ZOOM}
                step={0.01}
                value={frame?.zoom ?? 1}
                disabled={!frame || busy}
                onChange={(event) => {
                  const zoom = Number(event.target.value);
                  change((current) => ({ ...current, zoom }));
                }}
                className="block w-full accent-blue-600 disabled:opacity-40"
              />
              <p className="text-xs text-gray-500">
                {isPhoto ? "Drag to position your photo and zoom to frame your face." : "Zoom out to keep the whole image, or in on the part that reads best small."}
              </p>
            </div>

            <div className="space-y-2">
              <FieldLabel as="p">{isPhoto ? "Preview" : "In the sidebar"}</FieldLabel>
              {/* The sidebar's own heading: the mark at its size, then the
                  name in the sidebar's face. */}
              <div
                data-slot={isPhoto ? "profile-photo-preview" : "organization-logo-preview"}
                className="flex min-w-0 items-center gap-1.5 rounded-xl bg-gray-100 px-3 py-2.5"
              >
                {frame && image ? (
                  <FramedLogo
                    image={image}
                    frame={frame}
                    side={previewSide}
                    className={isPhoto ? "rounded-full" : "rounded-[3px]"}
                  />
                ) : (
                  <span
                    className="block shrink-0 animate-pulse rounded-[3px] bg-gray-200"
                    style={{ width: previewSide, height: previewSide }}
                  />
                )}
                <span className={isPhoto ? "min-w-0 text-sm [overflow-wrap:anywhere]" : "min-w-0 truncate font-serif text-xl font-light"}>
                  {name}
                </span>
              </div>
            </div>

            <p className="text-xs text-gray-500">
              PNG, JPEG or WebP, up to 10 MB.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
