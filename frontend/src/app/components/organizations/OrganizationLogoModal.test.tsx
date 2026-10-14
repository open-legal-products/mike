import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { OrgLogoFrame } from "@/app/lib/orgLogoImage";
import { OrganizationLogoModal } from "./OrganizationLogoModal";

// Drawing onto a canvas needs a real browser; what is drawn — the frame the
// person arrived at — is what these pin.
const mocks = vi.hoisted(() => ({ renderOrgLogo: vi.fn(), drawImage: vi.fn() }));
const decodes: { resolve: (image: ImageBitmap) => void; reject: (error: Error) => void }[] = [];
vi.mock("@/app/lib/orgLogoImage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/orgLogoImage")>()),
  renderOrgLogo: mocks.renderOrgLogo,
}));

const file = new File([new Uint8Array(4)], "logo.png", { type: "image/png" });
const RENDERED = "data:image/png;base64,FRAMED";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.renderOrgLogo.mockReturnValue(RENDERED);
  decodes.length = 0;
  vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>((resolve, reject) => {
    decodes.push({ resolve, reject });
  })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: mocks.drawImage,
    clearRect: vi.fn(),
    setTransform: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderModal(props: Partial<Parameters<typeof OrganizationLogoModal>[0]> = {}) {
  const handlers = { onCancel: vi.fn(), onSave: vi.fn() };
  const view = render(
    <OrganizationLogoModal
      file={file}
      organizationName="Acme LLP"
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view };
}

/** The browser finishing its read of the picked image, at this size. */
async function loadImage(width = 800, height = 200, decodeIndex = 0) {
  const source = { width, height, close: vi.fn() } as unknown as ImageBitmap;
  await act(async () => decodes[decodeIndex].resolve(source));
  return source;
}
const position = () => screen.getByRole("group", { name: /^Logo position/ });
const save = () => screen.getByRole("button", { name: "Save" });
/** The frame the logo would be saved with. */
async function savedFrame(user: ReturnType<typeof userEvent.setup>) {
  await user.click(save());
  return mocks.renderOrgLogo.mock.lastCall![1] as OrgLogoFrame;
}

describe("OrganizationLogoModal", () => {
  it("waits for the stored logo without flashing an unreadable-image error", () => {
    renderModal({ file: undefined, imageUrl: undefined });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
  });
  it("rejects oversized saved images before decoding", async () => {
    const atobSpy = vi.spyOn(window, "atob");
    renderModal({ file: undefined, imageUrl: "data:image/png;base64," + "A".repeat(15_000_000) });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(atobSpy).not.toHaveBeenCalled();
    expect(save()).toBeDisabled();
    atobSpy.mockRestore();
  });
  it("is named for the organization, and cannot save until the image has been read", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("Acme LLP").length).toBeGreaterThan(0);
    expect(save()).toBeDisabled();
    expect(screen.getByLabelText("Zoom")).toBeDisabled();
  });

  it("edits the saved image without saving an unchanged frame", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const { onSave } = renderModal({ file: undefined, imageUrl: "data:image/png;base64,aW1hZ2U=", onRemove });
    await loadImage(256, 256);
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Zoom"), { target: { value: "2" } });
    expect(save()).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Zoom"), { target: { value: "1" } });
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Zoom"), { target: { value: "2" } });
    position().focus();
    await user.keyboard("{ArrowRight}");
    await user.click(save());
    expect(onSave).toHaveBeenCalledWith(RENDERED);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("blocks editing, removal and closing during a removal", async () => {
    const onRemove = vi.fn();
    const { onCancel } = renderModal({ file: undefined, imageUrl: "data:image/png;base64,aW1hZ2U=", onRemove, removing: true });
    await loadImage(256, 256);
    expect(screen.getByRole("button", { name: "Removing..." })).toBeDisabled();
    expect(save()).toBeDisabled();
    expect(screen.getByLabelText("Zoom")).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("states the file types and the size limit", () => {
    renderModal();
    expect(
      screen.getByText("PNG, JPEG or WebP, up to 10 MB."),
    ).toBeInTheDocument();
  });

  it("starts with the picture filling the square, and saves what is framed as a PNG", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();
    const source = await loadImage(800, 200);

    await user.click(save());

    expect(mocks.renderOrgLogo).toHaveBeenCalledExactlyOnceWith(source, {
      imageWidth: 800,
      imageHeight: 200,
      zoom: 1,
      centerX: 400,
      centerY: 100,
    });
    expect(onSave).toHaveBeenCalledExactlyOnceWith(RENDERED);
  });

  it("zooms out to keep the whole image, down to where it all fits and no further", async () => {
    const user = userEvent.setup();
    renderModal();
    await loadImage(800, 200);
    const zoom = screen.getByLabelText("Zoom");
    // A wordmark four times as wide as tall fits whole at a quarter.
    expect(zoom).toHaveAttribute("min", "0.25");
    expect(zoom).toHaveAttribute("max", "4");

    fireEvent.change(zoom, { target: { value: "0.25" } });

    expect(await savedFrame(user)).toMatchObject({ zoom: 0.25, centerX: 400 });
  });

  it("moves the picture when it is dragged, and stops at its edge", async () => {
    const user = userEvent.setup();
    renderModal();
    await loadImage(800, 200);

    // Drag the picture 56px to the left: the square is 224px across and
    // shows 200 image pixels, so that is 50 of them.
    fireEvent.pointerDown(position(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(position(), { clientX: 44, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(position(), { pointerId: 1 });
    expect((await savedFrame(user)).centerX).toBeCloseTo(450);

    // A long drag stops where the picture's edge meets the square's.
    fireEvent.pointerDown(position(), { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(position(), { clientX: -5000, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(position(), { pointerId: 1 });
    expect((await savedFrame(user)).centerX).toBe(700);
  });

  it("does not move the picture once the pointer is released", async () => {
    const user = userEvent.setup();
    renderModal();
    await loadImage(800, 200);

    fireEvent.pointerDown(position(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(position(), { pointerId: 1 });
    fireEvent.pointerMove(position(), { clientX: 0, clientY: 100, pointerId: 1 });

    expect((await savedFrame(user)).centerX).toBe(400);
  });

  it("moves the picture with the arrow keys, for somebody not using a pointer", async () => {
    const user = userEvent.setup();
    renderModal();
    await loadImage(800, 200);

    position().focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");

    // Moving the picture right shows what is to its left.
    expect((await savedFrame(user)).centerX).toBeLessThan(400);
  });

  it("previews the logo at the size it has in the sidebar, beside the organization's name", async () => {
    renderModal();
    await loadImage(800, 200);

    const preview = document.querySelector<HTMLElement>(
      '[data-slot="organization-logo-preview"]',
    )!;
    expect(within(preview).getByText("Acme LLP")).toBeInTheDocument();
    const mark = preview.querySelector<HTMLCanvasElement>("canvas")!;
    expect(mark.style.width).toBe("18px");
    expect(mark.style.height).toBe("18px");
    // Only decoded pixels are drawn; the upload is never a DOM URL.
    expect(document.querySelector("img")).toBeNull();
    expect(mocks.drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ width: 800, height: 200 }), -27, 0, 72, 18,
    );
  });

  it("says so when the file is not really an image, and offers nothing to save", async () => {
    renderModal();
    await act(async () => decodes[0].reject(new Error("Invalid image")));

    expect(
      screen.getByText("That file could not be read as an image. Choose another."),
    ).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(screen.queryByLabelText("Zoom")).not.toBeInTheDocument();
  });

  it("can be cancelled, but not while the logo is being saved", async () => {
    const user = userEvent.setup();
    const { onCancel, rerender, onSave } = renderModal();
    await loadImage();

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(
      <OrganizationLogoModal
        file={file}
        organizationName="Acme LLP"
        saving
        onCancel={onCancel}
        onSave={onSave}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
  });

  it("still shows the image when React mounts it twice, releasing the stale decode", async () => {
    render(
      <StrictMode>
        <OrganizationLogoModal
          file={file}
          organizationName="Acme LLP"
          onCancel={vi.fn()}
          onSave={vi.fn()}
        />
      </StrictMode>,
    );
    const current = await loadImage(800, 200, 1);
    const stale = await loadImage(100, 100, 0);
    expect(stale.close).toHaveBeenCalledOnce();
    expect(current.close).not.toHaveBeenCalled();
    expect(save()).toBeEnabled();
    expect(mocks.drawImage).not.toHaveBeenCalledWith(stale, expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("releases decoded pixels when it closes", async () => {
    const { unmount } = renderModal();
    const image = await loadImage();
    unmount();
    expect(image.close).toHaveBeenCalledOnce();
  });

  it("releases an image that finishes decoding after the modal closes", async () => {
    const { unmount } = renderModal();
    unmount();
    const image = await loadImage();
    expect(image.close).toHaveBeenCalledOnce();
    expect(mocks.drawImage).not.toHaveBeenCalled();
  });

  it("rejects markup before trying to decode or display it", () => {
    renderModal({ file: new File(["<svg onload='alert(1)'/>"], "logo.svg", { type: "image/svg+xml" }) });
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeVisible();
    expect(save()).toBeDisabled();
    expect(document.querySelector("img, canvas")).toBeNull();
  });

  it("releases empty decoded images and disables saving", async () => {
    renderModal();
    const image = await loadImage(0, 0);
    expect(image.close).toHaveBeenCalledOnce();
    expect(save()).toBeDisabled();
    expect(screen.getByRole("alert")).toBeVisible();
  });

  it("clears the previous file's frame while its replacement is decoding", async () => {
    const { rerender, onSave, onCancel } = renderModal();
    const old = await loadImage();
    const replacement = new File(["new"], "new.png", { type: "image/png" });
    rerender(<OrganizationLogoModal file={replacement} organizationName="Acme LLP" onSave={onSave} onCancel={onCancel} />);
    expect(old.close).toHaveBeenCalledOnce();
    expect(save()).toBeDisabled();
    expect(document.querySelector("canvas")).toBeNull();
    const next = await loadImage(100, 400, 1);
    await userEvent.click(save());
    expect(mocks.renderOrgLogo).toHaveBeenCalledWith(next, expect.objectContaining({ imageWidth: 100, imageHeight: 400 }));
  });
});
