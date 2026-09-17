import { useState } from "react";
import {
    ModelToggleUI,
    type ModelToggleOption,
    type ReasoningLevel,
} from "@/shared/ui/ModelToggleUI";

const meta = { title: "Shared UI / ModelToggle" };
export default meta;

const models: ModelToggleOption[] = [
    { id: "openai/gpt-5.6", label: "GPT-5.6", group: "OpenAI" },
    { id: "anthropic/claude-opus-4.1", label: "Claude Opus 4.1", group: "Anthropic" },
    { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5", group: "Anthropic" },
    { id: "google/gemini-3-pro", label: "Gemini 3 Pro", group: "Google" },
];

export const Interactive = () => {
    const [value, setValue] = useState(models[0]!.id);
    const [reasoning, setReasoning] = useState<ReasoningLevel>("high");

    return (
        <ModelToggleUI
            value={value}
            onChange={setValue}
            models={models}
            reasoningLevel={reasoning}
            onReasoningChange={setReasoning}
        />
    );
};

export const ModalInput = () => {
    const [value, setValue] = useState(models[1]!.id);

    return (
        <div className="w-full max-w-80">
            <ModelToggleUI
                value={value}
                onChange={setValue}
                models={models}
                modalInput
            />
        </div>
    );
};

export const LoadingAndEmpty = () => (
    <div className="flex items-center gap-4">
        <ModelToggleUI value="" onChange={() => undefined} models={[]} loading />
        <ModelToggleUI
            value=""
            onChange={() => undefined}
            models={[]}
            onEmptyClick={() => undefined}
        />
    </div>
);
