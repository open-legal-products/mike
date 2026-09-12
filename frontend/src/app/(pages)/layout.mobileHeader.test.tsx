import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ptBR from "../../../messages/pt-BR.json";
import { withIntl } from "@/test/withIntl";
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
    const messages = {
        ...ptBR,
        shell: {
            ...ptBR.shell,
            header: { abrirMenu: ptBR.shared.appSidebar.abrirMenu },
        },
    };

    it("floats transparently over chat pages", () => {
        render(
            withIntl(
                <MikeLayout>
                    <div>Chat</div>
                </MikeLayout>,
                messages,
            ),
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
            withIntl(
                <MikeLayout>
                    <div>Page</div>
                </MikeLayout>,
                messages,
            ),
        );

        const toggle = screen.getByRole("button", { name: "Abrir menu lateral" });
        expect(toggle).toHaveClass("h-7", "w-7", "rounded-full");
        expect(toggle.parentElement).toHaveClass(
            "liquid-glass-subtle",
            "rounded-full",
        );
    });

    it("keeps the mobile header in normal flow on non-chat pages", () => {
        navigation.pathname = "/projects";
        render(
            withIntl(
                <MikeLayout>
                    <div>Projects</div>
                </MikeLayout>,
                messages,
            ),
        );

        const header = document.querySelector('[data-slot="mobile-header"]');
        expect(header).toHaveClass("relative", "shrink-0");
        expect(header).not.toHaveClass("fixed");
    });
});
