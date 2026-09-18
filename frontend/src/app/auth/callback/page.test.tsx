import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuthCallbackPage from "./page";

const { exchangeAuthCode, getAuthSession, refreshSession, router, params } =
    vi.hoisted(() => ({
        exchangeAuthCode: vi.fn(),
        getAuthSession: vi.fn(),
        refreshSession: vi.fn(),
        router: { replace: vi.fn() },
        params: new URLSearchParams("code=abc123"),
    }));

vi.mock("next/navigation", () => ({
    useRouter: () => router,
    useSearchParams: () => params,
}));

vi.mock("@/app/lib/authApi", () => ({ exchangeAuthCode, getAuthSession }));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ refreshSession }),
}));

vi.mock("@/app/lib/authRedirects", () => ({
    authErrorDescription: () => null,
    safeAuthNext: () => "/assistant",
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("AuthCallbackPage", () => {
    beforeEach(() => {
        exchangeAuthCode.mockReset();
        getAuthSession.mockReset();
        refreshSession.mockReset();
        refreshSession.mockResolvedValue(null);
        router.replace.mockReset();
    });

    it("calls a spent link spent", async () => {
        exchangeAuthCode.mockRejectedValue(
            Object.assign(new Error("Flow state expired"), {
                status: 401,
                code: "flow_state_expired",
            }),
        );

        render(<AuthCallbackPage />);

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "This confirmation link is invalid or has expired. Request a new one.",
        );
    });

    it("does not send the user chasing a new link when Mike is down", async () => {
        exchangeAuthCode.mockRejectedValue(
            Object.assign(new Error("boom"), { status: 503 }),
        );

        render(<AuthCallbackPage />);

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Mike is temporarily unavailable. Try again in a moment.",
        );
        expect(
            screen.getByRole("link", { name: "Contact support" }),
        ).toHaveAttribute("href", expect.stringContaining("will@mikeoss.com"));
    });
});
