import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SupportPage from "./page";

const { authenticatedFetch, router, auth } = vi.hoisted(() => ({
    authenticatedFetch: vi.fn(),
    router: { push: vi.fn() },
    auth: {
        user: { id: "user-1", email: "alex@example.com" },
        isAuthenticated: true,
        authLoading: false,
    },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

vi.mock("@/app/contexts/AuthContext", () => ({ useAuth: () => auth }));

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch }));

async function submitFeedback() {
    const user = userEvent.setup();
    render(<SupportPage />);
    await user.type(screen.getByLabelText(/Subject/), "Cannot upload");
    await user.type(screen.getByLabelText(/Message/), "It fails every time.");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    return user;
}

describe("SupportPage", () => {
    beforeEach(() => {
        authenticatedFetch.mockReset();
        router.push.mockReset();
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("says the message did not send, and offers a retry that works", async () => {
        authenticatedFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ detail: "no" }), { status: 503 }),
            )
            .mockResolvedValueOnce(new Response(null, { status: 204 }));

        const user = await submitFeedback();

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(
            "Mike is temporarily unavailable. Try again in a moment.",
        );
        expect(
            screen.getByRole("link", { name: "Email support directly" }),
        ).toHaveAttribute("href", expect.stringContaining("will@mikeoss.com"));

        await user.click(screen.getByRole("button", { name: "Retry" }));

        expect(authenticatedFetch).toHaveBeenCalledTimes(2);
        expect(
            await screen.findByText("Thank you for helping us improve."),
        ).toBeInTheDocument();
    });

    it("blames the connection when the request never lands", async () => {
        authenticatedFetch.mockRejectedValue(new TypeError("Failed to fetch"));

        await submitFeedback();

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Mike couldn't reach the server. Check your connection and try again.",
        );
    });
});
