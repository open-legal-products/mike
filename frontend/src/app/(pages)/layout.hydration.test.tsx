import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import MikeLayout from "./layout";

const state = vi.hoisted(() => ({ loading: true }));
vi.mock("next/navigation", () => ({
    usePathname: () => "/projects",
    useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ authLoading: state.loading, isAuthenticated: !state.loading }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    ChatHistoryProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/app/components/shared/AppSidebar", () => ({ AppSidebar: () => <aside>Sidebar</aside> }));

it("hydrates the server loading shell even when auth resolved before this boundary", async () => {
    state.loading = true;
    const container = document.createElement("div");
    container.innerHTML = renderToString(<MikeLayout><p>Workspace</p></MikeLayout>);
    document.body.append(container);
    // An outer provider can finish its request before this streamed/lazy
    // boundary hydrates, so its context already differs from the SSR snapshot.
    state.loading = false;
    const recoverableError = vi.fn();
    let root!: ReturnType<typeof hydrateRoot>;
    try {
        await act(async () => {
            root = hydrateRoot(container, <MikeLayout><p>Workspace</p></MikeLayout>, {
                onRecoverableError: recoverableError,
            });
        });
        expect(container).toHaveTextContent("Workspace");
        expect(recoverableError).not.toHaveBeenCalled();
    } finally {
        await act(async () => root?.unmount());
        container.remove();
    }
});
