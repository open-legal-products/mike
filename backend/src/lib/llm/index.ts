import { completeCommitteeText, streamCommitteeChat } from "./committee";
import { completeWithProvider, streamWithProvider } from "./providers";
import { getCommitteeModel } from "./registry";
import type {
    CompleteTextParams,
    StreamChatParams,
    StreamChatResult,
} from "./types";

export * from "./types";
export * from "./models";

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    if (getCommitteeModel(params.model, params.committeeModels)) {
        return streamCommitteeChat(params);
    }
    return streamWithProvider(params);
}

export async function completeText(
    params: CompleteTextParams,
): Promise<string> {
    if (getCommitteeModel(params.model, params.committeeModels)) {
        return completeCommitteeText(params);
    }
    return completeWithProvider(params);
}
