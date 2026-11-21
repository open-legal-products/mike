import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MfaVerificationPopup } from "./MfaVerificationPopup";

const { challengeAndVerifyMfa, getMfaAssurance, listMfaFactors } = vi.hoisted(
    () => ({
        challengeAndVerifyMfa: vi.fn(),
        getMfaAssurance: vi.fn(),
        listMfaFactors: vi.fn(),
    }),
);

vi.mock("@/app/lib/authApi", () => ({
    challengeAndVerifyMfa,
    getMfaAssurance,
    listMfaFactors,
}));

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function enterCode(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
        await screen.findByLabelText("Verification code digit 1"),
    );
    await user.paste("123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
}

describe("MfaVerificationPopup", () => {
    beforeEach(() => {
        challengeAndVerifyMfa.mockReset();
        listMfaFactors.mockReset();
        listMfaFactors.mockResolvedValue({
            totp: [{ id: "factor-1", factor_type: "totp" }],
        });
    });

    it("hands over to the caller once the code is accepted", async () => {
        challengeAndVerifyMfa.mockResolvedValue(undefined);
        const onVerified = vi.fn();
        const user = userEvent.setup();
        render(
            <MfaVerificationPopup open onCancel={vi.fn()} onVerified={onVerified} />,
        );

        await enterCode(user);

        await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
        expect(challengeAndVerifyMfa).toHaveBeenCalledWith("factor-1", "123456");
    });

    it("stays open against Escape and the close button while a code is being checked", async () => {
        const check = deferred();
        challengeAndVerifyMfa.mockReturnValue(check.promise);
        const onCancel = vi.fn();
        const onVerified = vi.fn();
        const user = userEvent.setup();
        render(
            <MfaVerificationPopup open onCancel={onCancel} onVerified={onVerified} />,
        );

        await enterCode(user);
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onCancel).not.toHaveBeenCalled();

        check.resolve();
        await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());

        // Not in flight any more: the same keys dismiss it again.
        await user.keyboard("{Escape}");
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it("does not run the caller's action for a prompt closed while its code was being checked", async () => {
        const check = deferred();
        challengeAndVerifyMfa.mockReturnValue(check.promise);
        const onVerified = vi.fn();
        const user = userEvent.setup();
        const { rerender } = render(
            <MfaVerificationPopup open onCancel={vi.fn()} onVerified={onVerified} />,
        );

        await enterCode(user);
        rerender(
            <MfaVerificationPopup
                open={false}
                onCancel={vi.fn()}
                onVerified={onVerified}
            />,
        );
        check.resolve();
        await check.promise;
        await Promise.resolve();
        expect(onVerified).not.toHaveBeenCalled();

        // Reopened, it is a fresh prompt rather than one stuck verifying.
        challengeAndVerifyMfa.mockResolvedValue(undefined);
        rerender(
            <MfaVerificationPopup open onCancel={vi.fn()} onVerified={onVerified} />,
        );
        await enterCode(user);
        await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
    });
});
