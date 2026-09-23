import type { UserProfile } from "./mikeApi";

export type DesktopGuestCredentials = { email: string; password: string };

export interface MikeDesktopBridge {
    guestCredentials?: () => Promise<DesktopGuestCredentials | null>;
    /** Answers only in the local app after its managed model is ready. */
    readyLocalModel?: () => Promise<string | null>;
}

declare global {
    interface Window {
        mikeDesktop?: MikeDesktopBridge;
    }
}

type StarterSelection = {
    lastSelectedChatModel: string;
    legalResearchUs: false;
};

const STARTER_MODELS = new Set(["ollama/qwen3.5:2b", "ollama/qwen3.5:4b"]);

/** Optional desktop convenience: never replace a saved or newly chosen model. */
export async function initializeDesktopLocalModel<
    T extends Pick<UserProfile, "lastSelectedChatModel">,
>(
    profile: T,
    bridge: MikeDesktopBridge | undefined,
    saveSelection: (selection: StarterSelection) => Promise<T>,
    isCurrent: () => boolean = () => true,
): Promise<T> {
    if (profile.lastSelectedChatModel || !bridge?.readyLocalModel)
        return profile;
    try {
        const model = await bridge.readyLocalModel();
        if (!model || !STARTER_MODELS.has(model) || !isCurrent())
            return profile;
        return await saveSelection({
            lastSelectedChatModel: model,
            // The starter works offline. Online legal research remains an
            // explicit setting the user can enable when they want it.
            legalResearchUs: false,
        });
    } catch {
        // An optional model/runtime failure must not degrade a valid profile.
        return profile;
    }
}
