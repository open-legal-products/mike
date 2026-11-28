import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";
import { PageHeader } from "./PageHeader";
import { PageSheet } from "./PageSheet";
import {
    PAGE_HEADER_ROW_CLASS,
    PAGE_HEADER_TITLE_CLASS,
} from "./pageHeaderStyles";

// The breadcrumbs measure themselves against a media query on a later frame.
vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
    })),
);

// A page's title is one size wherever it appears: as a plain title, as
// breadcrumbs, and as the placeholder shown while a name loads.
describe("PageHeader title size", () => {
    it("sits below the display headings", () => {
        expect(PAGE_HEADER_TITLE_CLASS.split(" ")).toEqual(
            expect.arrayContaining(["font-serif", "text-lg", "font-medium"]),
        );
        expect(PAGE_HEADER_TITLE_CLASS).not.toContain("text-2xl");
    });

    it("sets the breadcrumbs at the title's size", () => {
        render(
            <PageHeader
                breadcrumbs={[
                    { label: "Organization", onClick: () => {} },
                    { label: "Members", cursor: "text" },
                ]}
            />,
        );
        const trail = screen
            .getAllByText("Members")[0]
            .closest(".font-serif") as HTMLElement;
        expect(trail).toHaveClass("text-lg", "font-medium", "font-serif");
        expect(trail).not.toHaveClass("text-2xl");
    });

    it("holds a loading crumb's place at the height of a line of the title", () => {
        const { container } = render(
            <PageHeader
                breadcrumbs={[
                    { label: "Projects", onClick: () => {} },
                    { loading: true, skeletonClassName: "w-40" },
                ]}
            />,
        );
        const skeleton = container.querySelector(".animate-pulse");
        expect(skeleton).toHaveClass("h-5", "w-40");
    });

    it("sits its title on the same line as the sidebar's logo text", () => {
        // The sidebar's logo row is 40px tall and starts 12px down plus the
        // sidebar's 1px border, so its middle is 33px down. The header's 44px
        // of content has to start 11px down to share that middle.
        const { container } = render(
            <PageHeader>
                <h1>Projects</h1>
            </PageHeader>,
        );
        const header = container.firstElementChild;
        expect(header).toHaveClass(
            "min-h-[76px]",
            "md:pt-[11px]",
            "md:pb-[21px]",
        );
        expect(PAGE_HEADER_ROW_CLASS.split(" ")).toEqual(
            expect.arrayContaining([
                "min-h-[76px]",
                "md:pt-[11px]",
                "md:pb-[21px]",
            ]),
        );
    });

    it("lets a page pass its own title at the same size", () => {
        render(
            <PageHeader>
                <h1 className={`${PAGE_HEADER_TITLE_CLASS} text-gray-900`}>
                    Projects
                </h1>
            </PageHeader>,
        );
        expect(screen.getByRole("heading", { name: "Projects" })).toHaveClass(
            "text-lg",
            "font-serif",
        );
    });
});

// On a small screen only the current crumb shows; the way up to its parent is
// a back button in the top bar, beside the sidebar toggle.
describe("PageHeader on a small screen", () => {
    it("puts the way back in the top bar, not beside the title", async () => {
        const user = userEvent.setup();
        const back = vi.fn();
        const topBar = document.createElement("div");
        document.body.appendChild(topBar);
        const { container } = render(
            <PageChromeContext.Provider
                value={{ mobileActionsContainer: null, mobileBackContainer: topBar }}
            >
                <PageHeader
                    breadcrumbs={[
                        { label: "Settings", onClick: back, title: "Back to Settings" },
                        { label: "Memory", cursor: "text" },
                    ]}
                />
            </PageChromeContext.Provider>,
        );
        await user.click(
            within(topBar).getByRole("button", { name: "Back to Settings" }),
        );
        expect(back).toHaveBeenCalledTimes(1);
        expect(
            within(container).queryByRole("button", { name: "Back to Settings" }),
        ).toBeNull();
        topBar.remove();
    });

    it("keeps it beside the title where there is no top bar", () => {
        render(
            <PageHeader
                breadcrumbs={[
                    { label: "Settings", onClick: () => {}, title: "Back to Settings" },
                    { label: "Memory", cursor: "text" },
                ]}
            />,
        );
        expect(
            screen
                .getAllByRole("button", { name: "Back to Settings" })
                .some((button) => button.classList.contains("sm:hidden")),
        ).toBe(true);
    });

    it("lines its title up with the top bar's sidebar toggle", () => {
        const { container } = render(
            <PageHeader>
                <h1>Projects</h1>
            </PageHeader>,
        );
        expect(container.firstElementChild).toHaveClass("mx-4");
    });

    it("sets its title in line with the toolbar and table from md up", () => {
        const { container } = render(
            <PageHeader>
                <h1>Projects</h1>
            </PageHeader>,
        );
        // 24px in on the left; the buttons stay 20px from the right.
        expect(container.firstElementChild).toHaveClass("md:ml-6", "md:mr-5");
    });
});

// A page on a sheet: the header's groups are already on glass.
describe("PageHeader on a page sheet", () => {
    it("drops the groups' own pill beside the title, and keeps it in the top bar", () => {
        const topBar = document.createElement("div");
        document.body.appendChild(topBar);
        const { container } = render(
            <PageChromeContext.Provider
                value={{ mobileActionsContainer: topBar, mobileBackContainer: null }}
            >
                <PageSheet>
                    <PageHeader actions={[{ type: "new", title: "New project" }]}>
                        <h1>Projects</h1>
                    </PageHeader>
                </PageSheet>
            </PageChromeContext.Provider>,
        );

        const inHeader = within(container)
            .getByRole("button", { name: "New project" })
            .closest('[data-surface]');
        expect(inHeader).toHaveAttribute("data-surface", "plain");
        expect(inHeader).not.toHaveClass("liquid-glass-subtle");
        // The top bar is off the sheet.
        const inTopBar = within(topBar)
            .getByRole("button", { name: "New project" })
            .closest('[data-surface]');
        expect(inTopBar).toHaveClass("liquid-glass-subtle");
        topBar.remove();
    });

    it("keeps the groups' pill off a sheet", () => {
        render(
            <PageHeader actions={[{ type: "new", title: "New project" }]}>
                <h1>Projects</h1>
            </PageHeader>,
        );
        expect(
            screen.getByRole("button", { name: "New project" }).closest('[data-surface]'),
        ).toHaveClass("liquid-glass-subtle");
    });
});
