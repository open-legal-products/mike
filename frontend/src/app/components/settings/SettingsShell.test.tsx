import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsShell, type SettingsShellGroup } from "./SettingsShell";

vi.mock("next/navigation", () => ({
    usePathname: () => "/settings/byok",
    useRouter: () => ({ push: vi.fn() }),
}));

// Across the top of a narrow page the row is 200px wide; each tab is 120px,
// laid out one after another, so the third starts well out of view.
function layOut() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        function (this: HTMLElement) {
            if (this.classList.contains("overflow-x-auto"))
                return { left: 0, right: 200, width: 200 } as DOMRect;
            const button = this.closest("button") ?? this.querySelector("button");
            const buttons = Array.from(document.querySelectorAll("nav button"));
            const index = button ? buttons.indexOf(button) : 0;
            const left = index * 120;
            return { left, right: left + 120, width: 120 } as DOMRect;
        },
    );
}

const tab = (id: string) => ({ id, label: id, href: `/settings/${id}` });
const groups = (ids: string[]): SettingsShellGroup[] => [
    { id: "workspace", tabs: ids.map(tab) },
];

afterEach(() => vi.restoreAllMocks());

describe("SettingsShell", () => {
    it("brings the open section into view once it is listed", () => {
        layOut();
        const { rerender } = render(
            <SettingsShell
                title="Settings"
                navLabel="Settings"
                rootHref="/settings/memory"
                groups={groups(["memory", "connectors"])}
            >
                page
            </SettingsShell>,
        );
        const scroller = document.querySelector(".overflow-x-auto")!;
        expect(scroller.scrollLeft).toBe(0);

        // The organization's role loads: its sections join the row, the
        // open one among them, on the same path.
        rerender(
            <SettingsShell
                title="Settings"
                navLabel="Settings"
                rootHref="/settings/memory"
                groups={groups(["memory", "connectors", "byok"])}
            >
                page
            </SettingsShell>,
        );
        expect(
            screen.getByRole("button", { name: "byok" }),
        ).toHaveAttribute("aria-current", "page");
        expect(scroller.scrollLeft).toBe(240);
    });
});
