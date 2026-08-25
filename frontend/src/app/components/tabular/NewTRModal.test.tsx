import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    uploadProjectDocuments,
    uploadStandaloneDocuments,
} from "@/app/lib/mikeApi";
import type { Document } from "../shared/types";
import { NewTRModal } from "./NewTRModal";

vi.mock("@/app/lib/mikeApi", () => ({
    getProject: vi.fn(),
    listWorkflows: vi.fn(async () => []),
    uploadProjectDocuments: vi.fn(),
    uploadStandaloneDocuments: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            tabularModel: "gemini-3-flash-preview",
            apiKeys: {
                claude: { configured: false, source: null },
                gemini: { configured: true, source: "user" },
                openai: { configured: false, source: null },
                openrouter: { configured: false, source: null },
                vercel: { configured: false, source: null },
                "opencode-go": { configured: false, source: null },
                courtlistener: { configured: false, source: null },
            },
            openRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
        },
        loading: false,
        apiKeysDegraded: false,
    }),
}));

vi.mock("@/app/hooks/useOllamaModels", () => ({
    useOllamaModels: () => [],
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../shared/FileDirectory", () => ({
    FileDirectory: ({ tabs }: { tabs?: string[] }) => (
        <div>
            Document directory
            <span data-testid="directory-tabs">{tabs?.join(",")}</span>
        </div>
    ),
}));

describe("NewTRModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("shows folder grouping on the first screen and excludes Templates", () => {
        const onAdd = vi.fn();
        render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} />);

        expect(screen.getByText("Document grouping")).toBeInTheDocument();
        expect(
            screen.getByText(
                "Treat documents in the same folder as one review row",
            ),
        ).toBeInTheDocument();

        const reviewNameInput = screen.getByLabelText("Review name");
        const modelSelect = screen.getByRole("button", {
            name: "Choose model",
        });
        expect(
            reviewNameInput.compareDocumentPosition(modelSelect) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(modelSelect).toHaveClass(
            "h-10",
            "w-full",
            "rounded-xl",
            "liquid-glass-subtle",
        );

        fireEvent.change(reviewNameInput, {
            target: { value: "Closing review" },
        });
        const groupingSwitch = screen.getByRole("switch", {
            name: "Treat documents in the same folder as one review row",
        });
        expect(groupingSwitch).toHaveAttribute("aria-checked", "false");
        fireEvent.click(groupingSwitch);
        expect(groupingSwitch).toHaveAttribute("aria-checked", "true");
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        expect(screen.getByText("Document directory")).toBeInTheDocument();
        expect(screen.getByTestId("directory-tabs")).toHaveTextContent(
            "files,projects",
        );
        expect(screen.queryByText("Document grouping")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        expect(onAdd).toHaveBeenCalledWith(
            "Closing review",
            undefined,
            undefined,
            undefined,
            "folder",
            "gemini-3-flash-preview",
        );
    });

    it("stores uploads from a project review in that project", async () => {
        const uploadedDocument = {
            id: "uploaded-document",
            project_id: "project-1",
            filename: "New agreement.pdf",
            file_type: "pdf",
        };
        vi.mocked(uploadProjectDocuments).mockResolvedValue([
            {
                clientId: "client-1",
                filename: "New agreement.pdf",
                status: "completed",
                result: uploadedDocument as Document,
                errorCode: null,
            },
        ]);

        render(
            <NewTRModal
                open
                onClose={vi.fn()}
                onAdd={vi.fn()}
                projectId="project-1"
                projectDocs={[]}
                projectFolders={[]}
                projectName="Acquisition"
            />,
        );

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Project review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        const file = new File(["agreement"], "New agreement.pdf", {
            type: "application/pdf",
        });
        const input =
            document.querySelector<HTMLInputElement>('input[type="file"]');
        fireEvent.change(input!, { target: { files: [file] } });

        await waitFor(() =>
            expect(uploadProjectDocuments).toHaveBeenCalledWith("project-1", [
                { file },
            ]),
        );
        expect(uploadStandaloneDocuments).not.toHaveBeenCalled();
    });
});
