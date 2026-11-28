import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CONTENT_AREA_LEFT_VAR,
    CONTENT_AREA_RIGHT_VAR,
    useContentAreaInsets,
} from "./useContentAreaInsets";

let rect = { left: 262, right: 1440 };
let resize: (() => void) | null = null;
const root = () => document.documentElement.style;

function Area() {
    return <div ref={useContentAreaInsets()} data-testid="area" />;
}

beforeEach(() => {
    rect = { left: 262, right: 1440 };
    resize = null;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () => rect as DOMRect,
    );
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
        1440,
    );
    vi.stubGlobal(
        "ResizeObserver",
        class {
            constructor(callback: () => void) {
                resize = callback;
            }
            observe() {}
            disconnect() {}
        },
    );
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("useContentAreaInsets", () => {
    it("publishes where the content area sits in the window", () => {
        render(<Area />);
        expect(root().getPropertyValue(CONTENT_AREA_LEFT_VAR)).toBe("262px");
        expect(root().getPropertyValue(CONTENT_AREA_RIGHT_VAR)).toBe("0px");
    });

    it("follows the area as the sidebar opens and closes", () => {
        render(<Area />);
        rect = { left: 54, right: 1440 };
        act(() => resize?.());
        expect(root().getPropertyValue(CONTENT_AREA_LEFT_VAR)).toBe("54px");
    });

    it("follows the window as it resizes", () => {
        render(<Area />);
        vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
            1600,
        );
        act(() => window.dispatchEvent(new Event("resize")));
        expect(root().getPropertyValue(CONTENT_AREA_RIGHT_VAR)).toBe("160px");
    });

    it("leaves the window to centre on once the area is gone", () => {
        const { unmount } = render(<Area />);
        unmount();
        expect(root().getPropertyValue(CONTENT_AREA_LEFT_VAR)).toBe("");
        expect(root().getPropertyValue(CONTENT_AREA_RIGHT_VAR)).toBe("");
    });
});
