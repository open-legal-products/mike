import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MikeIcon } from "./MikeIconUI";

function firstBladeFill(container: HTMLElement) {
    const gradient = container.querySelector(
        'linearGradient[id$="-m-glassFill"]',
    );
    const stop = gradient?.querySelector("stop");
    return (stop as SVGStopElement | null)?.style.stopColor.replace(/\s/g, "");
}

afterEach(() => {
    document.documentElement.classList.remove("dark");
});

describe("MikeIcon", () => {
    it("renders the dark mark on the light theme", () => {
        const { container } = render(<MikeIcon />);

        expect(firstBladeFill(container)).toBe("rgb(10,10,10)");
    });

    it("renders the white mark when the document is in dark mode", () => {
        document.documentElement.classList.add("dark");
        const { container } = render(<MikeIcon />);

        expect(firstBladeFill(container)).toBe("rgb(255,255,255)");
    });

    it("swaps palettes when the theme class changes while mounted", async () => {
        const { container } = render(<MikeIcon />);
        expect(firstBladeFill(container)).toBe("rgb(10,10,10)");

        document.documentElement.classList.add("dark");

        await waitFor(() =>
            expect(firstBladeFill(container)).toBe("rgb(255,255,255)"),
        );
    });

    it("keeps the status palettes in dark mode", () => {
        document.documentElement.classList.add("dark");
        const { container } = render(<MikeIcon done />);

        expect(firstBladeFill(container)).toBe("rgb(74,222,128)");
    });
});
