import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MikeLayout from "./layout";

const navigation = vi.hoisted(() => ({
    pathname: "/assistant/chat/chat-1",
    push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    usePathname: () => navigation.pathname,
    useRouter: () => ({ push: navigation.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        isAuthenticated: true,
        authLoading: false,
    }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    ChatHistoryProvider: ({ children }: { children: React.ReactNode }) =>
        children,
}));
vi.mock("@/app/components/shared/AppSidebar", () => ({
    AppSidebar: () => null,
}));
vi.mock("@/app/components/shared/FullScreenLoader", () => ({
    FullScreenLoader: () => null,
}));

beforeEach(() => {
    navigation.pathname = "/assistant/chat/chat-1";
    navigation.push.mockReset();
});

describe("mobile page header", () => {
    it("floats transparently over chat pages", () => {
        render(
            <MikeLayout>
                <div>Chat</div>
            </MikeLayout>,
        );

        const header = document.querySelector('[data-slot="mobile-header"]');
        expect(header).toHaveClass(
            "fixed",
            "inset-x-0",
            "top-0",
            "bg-transparent",
        );
    });

    it("floats transparently over project chat workspaces", () => {
        navigation.pathname = "/projects/project-1/assistant/chat/chat-1";
        render(
            <MikeLayout>
                <div>Project chat</div>
            </MikeLayout>,
        );

        const header = document.querySelector('[data-slot="mobile-header"]');
        expect(header).toHaveClass(
            "fixed",
            "inset-x-0",
            "top-0",
            "bg-transparent",
        );
    });

    it("uses the header-button styling for the sidebar toggle", () => {
        render(
            <MikeLayout>
                <div>Page</div>
            </MikeLayout>,
        );

        const toggle = screen.getByRole("button", { name: "Open sidebar" });
        expect(toggle).toHaveClass("h-7", "w-7", "rounded-full");
        expect(toggle.parentElement).toHaveClass(
            "liquid-glass-subtle",
            "rounded-full",
        );
    });

    it("keeps the mobile header in normal flow on non-chat pages", () => {
        navigation.pathname = "/projects";
        render(
            <MikeLayout>
                <div>Projects</div>
            </MikeLayout>,
        );

        const header = document.querySelector('[data-slot="mobile-header"]');
        expect(header).toHaveClass("relative", "shrink-0");
        expect(header).not.toHaveClass("fixed");
    });
});
