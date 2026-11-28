import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsShell } from "./SettingsShell";

const navigation = vi.hoisted(() => ({ pathname: "/settings", push: vi.fn() }));

vi.mock("next/navigation", () => ({
    usePathname: () => navigation.pathname,
    useRouter: () => ({ push: navigation.push }),
}));

const GROUPS = [
    {
        id: "personal",
        label: "Personal",
        sections: [
            {
                id: "memory",
                label: "Memory",
                description: "What Mike remembers.",
                href: "/settings/memory",
                icon: () => null,
            },
        ],
    },
];

function renderShell() {
    return render(
        <SettingsShell
            title="Settings"
            rootHref="/settings"
            groups={GROUPS as never}
            search={(variant) => <span data-testid={`search-${variant}`} />}
        >
            <p>content</p>
        </SettingsShell>,
    );
}

beforeEach(() => {
    navigation.pathname = "/settings";
});

describe("SettingsShell", () => {
    it("heads the overview in its centre column, the search beneath, with no page header", () => {
        const { container } = renderShell();

        const heading = screen.getByRole("heading", { level: 1, name: "Settings" });
        const block = container.querySelector(
            '[data-slot="settings-overview-heading"]',
        );
        expect(block).toContainElement(heading);
        expect(block).toContainElement(screen.getByTestId("search-field"));
        expect(block).toHaveClass("items-center", "text-center");
        expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
        expect(screen.queryByTestId("search-button")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Back to Settings" }),
        ).not.toBeInTheDocument();
    });

    it("keeps a section's page header, with the search as a button in it", () => {
        navigation.pathname = "/settings/memory";
        const { container } = renderShell();

        expect(
            screen.getAllByRole("button", { name: "Back to Settings" }).length,
        ).toBeGreaterThan(0);
        expect(screen.getByTestId("search-button")).toBeInTheDocument();
        expect(screen.queryByTestId("search-field")).not.toBeInTheDocument();
        expect(
            container.querySelector('[data-slot="settings-overview-heading"]'),
        ).toBeNull();
    });
});
