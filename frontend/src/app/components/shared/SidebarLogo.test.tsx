import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearOrganizationLogoCache } from "@/app/hooks/useOrganizationLogo";
import { SidebarLogo } from "./SidebarLogo";

const mocks = vi.hoisted(() => ({ getOrgLogo: vi.fn() }));

vi.mock("@/app/lib/mikeApi", () => ({ getOrgLogo: mocks.getOrgLogo }));
vi.mock("@/shared/ui/MikeIconUI", () => ({
    MikeIcon: () => <span data-testid="mike-icon" />,
}));

const LOGO = "data:image/png;base64,AAAA";
const acme = (logo_updated_at: string | null) => ({
    id: "org-acme",
    name: "Acme LLP",
    logo_updated_at,
});
const image = (container: HTMLElement) =>
    container.querySelector<HTMLImageElement>('[data-slot="sidebar-logo"]');

beforeEach(() => {
    vi.clearAllMocks();
    clearOrganizationLogoCache();
    mocks.getOrgLogo.mockResolvedValue(LOGO);
});

describe("SidebarLogo", () => {
    it("is the app's logo in the personal workspace", () => {
        render(<SidebarLogo organization={null} />);
        expect(screen.getByTestId("mike-icon")).toBeInTheDocument();
        expect(mocks.getOrgLogo).not.toHaveBeenCalled();
    });

    it("is the app's logo for an organization that has not set one, without asking", () => {
        render(<SidebarLogo organization={acme(null)} />);
        expect(screen.getByTestId("mike-icon")).toBeInTheDocument();
        expect(mocks.getOrgLogo).not.toHaveBeenCalled();
    });

    it("is the organization's logo once it has set one, at the mark's size", async () => {
        const { container } = render(
            <SidebarLogo organization={acme("2026-10-12T10:00:00Z")} />,
        );

        await waitFor(() => expect(image(container)).not.toBeNull());
        const logo = image(container)!;
        expect(logo).toHaveAttribute("src", LOGO);
        expect(logo.style.width).toBe("18px");
        expect(logo.style.height).toBe("18px");
        // Decorative: the organization's name is the text beside it.
        expect(logo).toHaveAttribute("alt", "");
        expect(screen.queryByTestId("mike-icon")).not.toBeInTheDocument();
        expect(mocks.getOrgLogo).toHaveBeenCalledExactlyOnceWith("org-acme");
    });

    it("holds the logo's place while it loads, rather than flashing the app's", () => {
        mocks.getOrgLogo.mockReturnValue(new Promise(() => {}));
        const { container } = render(
            <SidebarLogo organization={acme("2026-10-12T10:00:00Z")} />,
        );
        expect(
            container.querySelector('[data-slot="sidebar-logo-loading"]'),
        ).not.toBeNull();
        expect(screen.queryByTestId("mike-icon")).not.toBeInTheDocument();
    });

    it("falls back to the app's logo when the organization's cannot be read", async () => {
        mocks.getOrgLogo.mockRejectedValue(new Error("network"));
        render(<SidebarLogo organization={acme("2026-10-12T10:00:00Z")} />);
        expect(await screen.findByTestId("mike-icon")).toBeInTheDocument();
    });

    it("fetches again when the logo changes, and not when nothing has", async () => {
        const { container, rerender } = render(
            <SidebarLogo organization={acme("2026-10-12T10:00:00Z")} />,
        );
        await waitFor(() => expect(image(container)).not.toBeNull());

        // The same version, drawn again somewhere else: one read serves both.
        rerender(<SidebarLogo organization={acme("2026-10-12T10:00:00Z")} />);
        render(<SidebarLogo organization={acme("2026-10-12T10:00:00Z")} />);
        expect(mocks.getOrgLogo).toHaveBeenCalledTimes(1);

        mocks.getOrgLogo.mockResolvedValue("data:image/png;base64,BBBB");
        rerender(<SidebarLogo organization={acme("2026-10-12T11:00:00Z")} />);
        await waitFor(() =>
            expect(image(container)).toHaveAttribute(
                "src",
                "data:image/png;base64,BBBB",
            ),
        );
        expect(mocks.getOrgLogo).toHaveBeenCalledTimes(2);
    });

    it("returns to the app's logo when the organization removes its own", async () => {
        const { container, rerender } = render(
            <SidebarLogo organization={acme("2026-10-12T10:00:00Z")} />,
        );
        await waitFor(() => expect(image(container)).not.toBeNull());

        rerender(<SidebarLogo organization={acme(null)} />);
        expect(screen.getByTestId("mike-icon")).toBeInTheDocument();
        expect(image(container)).toBeNull();
    });
});
