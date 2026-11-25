import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";
import { PageHeader } from "./PageHeader";
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
    it("is one step below the display headings", () => {
        expect(PAGE_HEADER_TITLE_CLASS.split(" ")).toEqual(
            expect.arrayContaining(["font-serif", "text-xl", "font-medium"]),
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
        expect(trail).toHaveClass("text-xl", "font-medium", "font-serif");
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
        // The sidebar's logo row is 44px tall and starts 12px down plus the
        // sidebar's 1px border. The header's 44px of content has to start
        // 13px down too, or the title rides a pixel above the logo.
        // (Measured in a browser; the classes are what hold it there.)
        const { container } = render(
            <PageHeader>
                <h1>Projects</h1>
            </PageHeader>,
        );
        const header = container.firstElementChild;
        expect(header).toHaveClass(
            "min-h-[76px]",
            "md:pt-[13px]",
            "md:pb-[19px]",
        );
        expect(PAGE_HEADER_ROW_CLASS.split(" ")).toEqual(
            expect.arrayContaining([
                "min-h-[76px]",
                "md:pt-[13px]",
                "md:pb-[19px]",
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
            "text-xl",
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
        expect(container.firstElementChild).toHaveClass("mx-4", "md:mx-6");
    });
});
