import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarHeading } from "./SidebarHeading";

// jsdom lays nothing out, so the two widths the component compares are
// supplied here: the room the header row has, and how wide each name would
// be on one line at full size.
const ROOM = 160;
const FULL_SIZE_WIDTHS: Record<string, number> = {
    Mike: 44,
    "Acme LLP": 92,
    "Exactly Fits": ROOM,
    "Hargreaves Whitcombe Delacroix & Partners International LLP": 610,
};
const LONG = "Hargreaves Whitcombe Delacroix & Partners International LLP";

let room = ROOM;
let resizeCallbacks: (() => void)[] = [];

beforeEach(() => {
    room = ROOM;
    resizeCallbacks = [];
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
        () => room,
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
        function (this: HTMLElement) {
            return FULL_SIZE_WIDTHS[this.textContent ?? ""] ?? 0;
        },
    );
    vi.stubGlobal(
        "ResizeObserver",
        class {
            constructor(callback: () => void) {
                resizeCallbacks.push(callback);
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

const heading = () =>
    document.querySelector('[data-slot="sidebar-heading"]') as HTMLElement;

describe("SidebarHeading", () => {
    it.each(["Mike", "Acme LLP", "Exactly Fits"])(
        "sets %s at full size on one line",
        (name) => {
            render(<SidebarHeading name={name} />);
            expect(heading()).toHaveTextContent(name);
            expect(heading()).toHaveAttribute("data-size", "full");
            expect(heading()).toHaveClass("text-xl");
            expect(heading()).not.toHaveClass("text-base");
            expect(heading()).not.toHaveAttribute("title");
        },
    );

    it("gives an organization's name exactly the styling Mike has when it fits", () => {
        const { unmount } = render(<SidebarHeading name="Mike" />);
        const mike = heading().className;
        unmount();
        render(<SidebarHeading name="Acme LLP" />);
        expect(heading().className).toBe(mike);
    });

    it("drops to the smaller two-line setting only when the name does not fit", () => {
        render(<SidebarHeading name={LONG} />);
        expect(heading()).toHaveAttribute("data-size", "compact");
        expect(heading()).toHaveClass("text-base", "line-clamp-2", "break-words");
        expect(heading()).not.toHaveClass("text-xl");
        // Two lines may still not hold it, so the full name stays reachable.
        expect(heading()).toHaveAttribute("title", LONG);
    });

    it("re-measures when the name changes", () => {
        const { rerender } = render(<SidebarHeading name={LONG} />);
        expect(heading()).toHaveAttribute("data-size", "compact");

        rerender(<SidebarHeading name="Acme LLP" />);
        expect(heading()).toHaveAttribute("data-size", "full");
        expect(heading()).not.toHaveAttribute("title");
    });

    it("re-measures when the room changes, as it does while the sidebar opens", () => {
        room = 60;
        render(<SidebarHeading name="Acme LLP" />);
        expect(heading()).toHaveAttribute("data-size", "compact");

        room = ROOM;
        act(() => resizeCallbacks.forEach((callback) => callback()));
        expect(heading()).toHaveAttribute("data-size", "full");
    });

    it("keeps the measuring copy out of the accessible name", () => {
        render(<SidebarHeading name="Acme LLP" />);
        const copies = document.querySelectorAll('[aria-hidden="true"]');
        expect(copies).toHaveLength(1);
        expect(copies[0]).toHaveClass("invisible", "absolute");
        expect(heading().textContent).toBe("Acme LLP");
    });
});
