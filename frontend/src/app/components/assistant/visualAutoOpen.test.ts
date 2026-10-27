import { describe, expect, it } from "vitest";
import type { AssistantEvent } from "../shared/types";
import { latestVisualInTurn } from "./visualAutoOpen";

describe("latestVisualInTurn", () => {
    it("follows an edit to the visual's newest version and skips a failed one", () => {
        const visual = { filename: "Dashboard.html", download_url: "", document_id: "doc" };
        const events = [
            { type: "doc_created", ...visual, version_id: "v1", version_number: 1 },
            { type: "doc_edited", ...visual, version_id: "v2", version_number: 2, annotations: [] },
            { type: "doc_edited", ...visual, version_id: "v3", version_number: 3, annotations: [], error: "rejected" },
        ] as AssistantEvent[];
        expect(latestVisualInTurn(events)).toMatchObject({ documentId: "doc", versionId: "v2" });
    });
});
