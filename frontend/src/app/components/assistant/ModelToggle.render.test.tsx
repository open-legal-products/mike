import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelToggle } from "./ModelToggle";
import type { ApiKeyState } from "@/app/lib/mikeApi";

vi.mock("@/app/hooks/useOllamaModels", () => ({
    useOllamaModels: () => [],
}));

function keys(configured: Partial<Record<keyof ApiKeyState, boolean>>) {
    const providers = [
        "claude",
        "gemini",
        "openai",
        "openrouter",
        "vercel",
        "opencode-go",
        "courtlistener",
    ] as const;
    return Object.fromEntries(
        providers.map((provider) => [
            provider,
            {
                configured: configured[provider] ?? false,
                source: configured[provider] ? "user" : null,
            },
        ]),
    ) as ApiKeyState;
}

describe("ModelToggle responsive trigger", () => {
    it("uses the Settings2 icon in a compact chat input", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                compact
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toHaveClass("w-8", "rounded-lg");
        expect(trigger).not.toHaveClass("rounded-full");
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger.querySelector("svg")).toBeInTheDocument();
    });

    it("allows a wider model label in the regular trigger", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        expect(screen.getByText("Gemini 3 Flash")).toHaveClass("max-w-[200px]");
    });

    it("does not add an inset shadow to the selected model row", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));

        const selectedRow = screen
            .getAllByText("Gemini 3 Flash")
            .find((element) => element.closest('[role="menuitem"]'))
            ?.closest('[role="menuitem"]');
        expect(selectedRow).toHaveClass("theme-dropdown-item", "text-gray-900");
        expect(selectedRow).toHaveClass("rounded-md");
        expect(selectedRow).not.toHaveClass("rounded-xl");
        expect(selectedRow).toHaveAttribute("data-selected", "true");
        expect(selectedRow?.className).not.toContain("shadow-[inset_");
    });
});

describe("ModelToggle availability states", () => {
    it("renders a neutral disabled trigger while keys are loading", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeysLoading
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toBeDisabled();
        // The load-time flash: never claim "No API Key" before we know.
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger).toHaveTextContent("Gemini 3 Flash");
    });

    it("fails open when key state is unknown after a failed load", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toBeEnabled();
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger).toHaveTextContent("Gemini 3 Flash");
    });

    it("still reports No API Key when a LOADED state has no keys", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({})}
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toBeDisabled();
        expect(trigger).toHaveTextContent("No API Key");
    });

    it("filters to configured providers when keys are loaded", () => {
        render(
            <ModelToggle
                value="claude-fable-5"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        // Claude has no key: the stored selection is not offered, so the
        // trigger falls back to the picker prompt.
        expect(
            screen.getByRole("button", { name: "Choose model" }),
        ).toHaveTextContent("Select model");
    });
});

describe("ModelToggle OpenCode Go group", () => {
    it("offers the user's saved OpenCode Go models once the key is configured", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true, "opencode-go": true })}
                openCodeGoModels={["glm-5"]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        await user.click(await screen.findByText("OpenCode Go"));

        expect(await screen.findByText("Glm 5")).toBeInTheDocument();
    });

    it("hides the group when the OpenCode Go key is missing", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
                openCodeGoModels={["glm-5"]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));

        expect(screen.queryByText("OpenCode Go")).not.toBeInTheDocument();
    });
});

describe("ModelToggle committee group", () => {
    const panel = {
        id: "user-committee/panel",
        label: "Trademark panel",
        members: ["claude-opus-5", "gemini-3-flash-preview"],
        chair: "gpt-5.5",
    };

    it("offers a committee whose members and chair are all usable", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ claude: true, gemini: true, openai: true })}
                committees={[panel]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        await user.click(await screen.findByText("Committee"));

        expect(await screen.findByText("Trademark panel")).toBeInTheDocument();
    });

    it("hides a committee when one member's key is missing", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                // No OpenAI key, so the chair cannot run.
                apiKeys={keys({ claude: true, gemini: true })}
                committees={[panel]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));

        expect(screen.queryByText("Committee")).not.toBeInTheDocument();
    });

    it("selects the committee by its id", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={onChange}
                apiKeys={keys({ claude: true, gemini: true, openai: true })}
                committees={[panel]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        await user.click(await screen.findByText("Committee"));
        await user.click(await screen.findByText("Trademark panel"));

        expect(onChange).toHaveBeenCalledWith("user-committee/panel");
    });
});
