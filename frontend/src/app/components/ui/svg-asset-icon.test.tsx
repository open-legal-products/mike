import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SvgAssetIcon } from "./svg-asset-icon";

const asset = { src: "/_next/static/media/settings.abc123.svg", width: 64, height: 64 };

describe("SvgAssetIcon", () => {
    it("loads the versioned SVG immediately without an image-optimizer request", () => {
        const { container } = render(<SvgAssetIcon src={asset} />);
        const img = container.querySelector("img");
        expect(img).toHaveAttribute("src", asset.src);
        expect(img).toHaveAttribute("loading", "eager");
        expect(img).toHaveAttribute("decoding", "sync");
        expect(img).not.toHaveAttribute("srcset");
        expect(img).toHaveAttribute("alt", "");
        expect(img).toHaveAttribute("aria-hidden", "true");
    });

    it("preserves the caller's icon size and styling", () => {
        const { container } = render(
            <SvgAssetIcon src={asset} width={14} height={14} className="h-3.5 w-3.5 shrink-0" />,
        );
        const img = container.querySelector("img");
        expect(img).toHaveAttribute("width", "14");
        expect(img).toHaveAttribute("height", "14");
        expect(img).toHaveClass("h-3.5", "w-3.5", "shrink-0", "object-contain");
    });
});
