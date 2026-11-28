import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearOrganizationLogoCache } from "@/app/hooks/useOrganizationLogo";
import { avatarColour } from "@/app/components/ui/user-avatar";
import { WorkspaceMenuIcon } from "./WorkspaceMenuIcon";

const mocks = vi.hoisted(() => ({ getOrgLogo: vi.fn() }));

vi.mock("@/app/lib/mikeApi", () => ({ getOrgLogo: mocks.getOrgLogo }));
vi.mock("@mike/ui", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@mike/ui")>()),
    MikeIcon: () => <span data-testid="mike-icon" />,
}));

const LOGO = "data:image/png;base64,AAAA";
const acme = (logo_updated_at: string | null) => ({
    id: "org-acme",
    name: "acme LLP",
    logo_updated_at,
});
const slot = (container: HTMLElement, name: string) =>
    container.querySelector<HTMLElement>(`[data-slot="${name}"]`);

beforeEach(() => {
    vi.clearAllMocks();
    clearOrganizationLogoCache();
    mocks.getOrgLogo.mockResolvedValue(LOGO);
});

describe("WorkspaceMenuIcon", () => {
    it("is the app's logo for personal work", () => {
        render(<WorkspaceMenuIcon organization={null} />);
        expect(screen.getByTestId("mike-icon")).toBeInTheDocument();
        expect(mocks.getOrgLogo).not.toHaveBeenCalled();
    });

    it("is the organization's logo once it has set one", async () => {
        const { container } = render(
            <WorkspaceMenuIcon organization={acme("2026-10-12T10:00:00Z")} />,
        );

        await waitFor(() =>
            expect(slot(container, "workspace-icon")).not.toBeNull(),
        );
        const logo = slot(container, "workspace-icon")!;
        expect(logo).toHaveAttribute("src", LOGO);
        expect(logo).toHaveAttribute("alt", "");
        expect(logo.style.width).toBe("16px");
        expect(mocks.getOrgLogo).toHaveBeenCalledExactlyOnceWith("org-acme");
    });

    it("holds the logo's place while it loads, showing neither mark", () => {
        mocks.getOrgLogo.mockReturnValue(new Promise(() => {}));
        const { container } = render(
            <WorkspaceMenuIcon organization={acme("2026-10-12T10:00:00Z")} />,
        );

        expect(slot(container, "workspace-icon-loading")).not.toBeNull();
        expect(slot(container, "workspace-icon-placeholder")).toBeNull();
        expect(screen.queryByTestId("mike-icon")).not.toBeInTheDocument();
    });

    it("is a placeholder with its initial, not the app's logo, when it has none", () => {
        const { container } = render(
            <WorkspaceMenuIcon organization={acme(null)} />,
        );

        const placeholder = slot(container, "workspace-icon-placeholder");
        expect(placeholder).toHaveTextContent("A");
        expect(placeholder?.style.width).toBe("16px");
        expect(placeholder).toHaveClass(
            "rounded-full",
            "text-white",
            avatarColour(null, "org-acme"),
        );
        expect(placeholder).not.toHaveClass("bg-gray-200");
        expect(screen.queryByTestId("mike-icon")).not.toBeInTheDocument();
        expect(mocks.getOrgLogo).not.toHaveBeenCalled();
    });

    it("keeps an organization's colour through a rename", () => {
        const { container, rerender } = render(
            <WorkspaceMenuIcon organization={acme(null)} />,
        );
        const colour = [
            ...slot(container, "workspace-icon-placeholder")!.classList,
        ].filter((name) => name.startsWith("bg-"));
        expect(colour).toHaveLength(1);

        rerender(
            <WorkspaceMenuIcon
                organization={{ ...acme(null), name: "Acme & Co" }}
            />,
        );
        expect(slot(container, "workspace-icon-placeholder")).toHaveClass(
            colour[0],
        );
    });

    it("falls back to the placeholder when the logo cannot be read", async () => {
        mocks.getOrgLogo.mockRejectedValue(new Error("offline"));
        const { container } = render(
            <WorkspaceMenuIcon organization={acme("2026-10-12T10:00:00Z")} />,
        );

        await waitFor(() =>
            expect(
                slot(container, "workspace-icon-placeholder"),
            ).toHaveTextContent("A"),
        );
    });
});
