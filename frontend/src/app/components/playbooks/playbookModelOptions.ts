import type { ModelOption } from "@/app/components/assistant/ModelToggle";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import type {
    ApiKeyState,
    PlaybookConfiguration,
} from "@/app/lib/mikeApi";

export function buildPlaybookModelOptions(
    catalog: ModelOption[],
    configuration: PlaybookConfiguration | null,
    apiKeys?: ApiKeyState,
): Array<{ value: string; label: string }> {
    if (!configuration) return [];
    const serverAvailable = new Set(configuration.availableModelIds);
    return catalog
        .filter(
            (model) =>
                serverAvailable.has(model.id) ||
                (!!apiKeys && isModelAvailable(model.id, apiKeys)),
        )
        .map((model) => ({
            value: model.id,
            label: `${model.group} · ${model.label}`,
        }));
}
