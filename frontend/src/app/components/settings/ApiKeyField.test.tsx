import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyField } from "./ApiKeyField";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

const { needsMfaVerification } = vi.hoisted(() => ({
    needsMfaVerification: vi.fn(),
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    needsMfaVerification,
    MfaVerificationPopup: () => null,
}));

vi.mock("@/app/lib/mikeApi", () => ({
    isMfaRequiredError: () => false,
}));

function renderField(overrides: {
    onSave?: (value: string) => Promise<boolean>;
    onRemove?: () => Promise<boolean>;
    hasSavedKey?: boolean;
}) {
    render(
        <>
            <ApiKeyField
                label="Anthropic API key"
                placeholder="sk-..."
                hasSavedKey={overrides.hasSavedKey ?? false}
                onSave={overrides.onSave ?? (async () => true)}
                onRemove={overrides.onRemove ?? (async () => true)}
            />
            <ToastViewportUI />
        </>,
    );
    return screen.getByLabelText("Anthropic API key") as HTMLInputElement;
}

describe("ApiKeyField", () => {
    beforeEach(() => {
        clearToasts();
        needsMfaVerification.mockReset();
        needsMfaVerification.mockResolvedValue(false);
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        clearToasts();
    });

    it("reports a refused save in a toast with a retry, not an alert", async () => {
        const alertSpy = vi.fn();
        vi.stubGlobal("alert", alertSpy);
        const onSave = vi
            .fn<() => Promise<boolean>>()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const user = userEvent.setup();
        renderField({ onSave });

        await user.type(screen.getByLabelText("Anthropic API key"), "sk-test");
        await user.click(screen.getByRole("button", { name: "Save" }));

        const toast = await screen.findByRole("alert");
        expect(toast).toHaveTextContent("Couldn't save your Anthropic API key");
        expect(toast).toHaveTextContent(
            "Mike couldn't save your Anthropic API key. The key was not changed.",
        );
        expect(alertSpy).not.toHaveBeenCalled();

        await user.click(
            await screen.findByRole("button", { name: "Retry" }),
        );
        expect(onSave).toHaveBeenCalledTimes(2);

        vi.unstubAllGlobals();
    });

    it("explains a network failure instead of echoing it", async () => {
        const onSave = vi
            .fn<() => Promise<boolean>>()
            .mockRejectedValue(new TypeError("Failed to fetch"));
        const user = userEvent.setup();
        renderField({ onSave });

        await user.type(screen.getByLabelText("Anthropic API key"), "sk-test");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Mike couldn't reach the server. Check your connection and try again.",
        );
    });

    it("does not resend the old key when Retry follows a correction", async () => {
        const onSave = vi
            .fn<(value: string) => Promise<boolean>>()
            .mockResolvedValue(false);
        const user = userEvent.setup();
        renderField({ onSave });

        const input = screen.getByLabelText("Anthropic API key");
        await user.type(input, "sk-typo");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByRole("alert")).toBeInTheDocument();

        // The user fixes the key before reaching for the toast.
        await user.clear(input);
        await user.type(input, "sk-correct");
        await user.click(await screen.findByRole("button", { name: "Retry" }));

        // The stale value is never sent again...
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith("sk-typo");
        // ...and the user is told why nothing happened.
        expect(await screen.findByRole("status")).toHaveTextContent(
            "has changed since that attempt",
        );
        expect(input).toHaveValue("sk-correct");
    });

    it("retries the same key when the field is untouched", async () => {
        const onSave = vi
            .fn<(value: string) => Promise<boolean>>()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const user = userEvent.setup();
        renderField({ onSave });

        await user.type(screen.getByLabelText("Anthropic API key"), "sk-same");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await user.click(await screen.findByRole("button", { name: "Retry" }));

        expect(onSave).toHaveBeenCalledTimes(2);
        expect(onSave).toHaveBeenLastCalledWith("sk-same");
    });

    it("reports a refused removal and leaves the key in place", async () => {
        const onRemove = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
        const user = userEvent.setup();
        renderField({ onRemove, hasSavedKey: true });

        await user.click(screen.getByRole("button", { name: "Remove" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Mike couldn't remove your Anthropic API key. The key is still saved.",
        );
    });
});

// Ported from #495, which introduced the saved-key mask, and #498. The mask
// behaviour is unchanged by #496; only the failure surface moved from a
// blocking popup to the shared toast.
describe("ApiKeyField saved-key mask", () => {
    beforeEach(() => {
        clearToasts();
        needsMfaVerification.mockReset();
        needsMfaVerification.mockResolvedValue(false);
    });
    afterEach(() => {
        clearToasts();
    });

    it("shows a masked value when a key is saved", () => {
        const input = renderField({ hasSavedKey: true });

        expect(input.type).toBe("password");
        expect(input.value.length).toBeGreaterThan(0);
        expect(input.readOnly).toBe(true);
        expect(screen.queryByText("Saved key hidden")).toBeNull();
    });

    it("shows an empty input with the placeholder when no key is saved", () => {
        const input = renderField({});

        expect(input.value).toBe("");
        expect(input.placeholder).toBe("sk-...");
        expect(input.readOnly).toBe(false);
    });

    it("clears the mask on focus so a replacement key can be entered", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
        const input = renderField({ hasSavedKey: true, onSave });

        await user.click(input);
        expect(input.value).toBe("");
        expect(input.readOnly).toBe(false);

        await user.type(input, "new-key");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(onSave).toHaveBeenCalledWith("new-key");
    });

    it("restores the mask when focus leaves without a new key", async () => {
        const user = userEvent.setup();
        const input = renderField({ hasSavedKey: true });

        await user.click(input);
        await user.tab();

        expect(input.value.length).toBeGreaterThan(0);
        expect(input.readOnly).toBe(true);
    });

    it("reports a removal that throws, not only one that returns false", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const user = userEvent.setup();
        renderField({
            hasSavedKey: true,
            onRemove: vi
                .fn<() => Promise<boolean>>()
                .mockRejectedValue(new Error("network unavailable")),
        });

        await user.click(screen.getByRole("button", { name: "Remove" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Couldn't remove your Anthropic API key",
        );
    });
});
