import {
    getClaudeCodeModels,
    type ClaudeCodeModelOption,
} from "@/app/lib/mikeApi";
import { createDynamicModelStore } from "./dynamicModelStore";

// Empty list unless the backend enables its local Claude Code CLI.
const store = createDynamicModelStore<ClaudeCodeModelOption>(() =>
    getClaudeCodeModels(),
);

export function useClaudeCodeModels(): ClaudeCodeModelOption[] {
    return store.useModels();
}
