import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
    getTabularReview,
    stopTabularGeneration,
    streamTabularGeneration,
    streamTabularGenerationResume,
} from "@/app/lib/mikeApi";
import type {
    TabularReview,
    TabularReviewRow,
} from "@/app/components/shared/types";
import { TRView } from "./TabularReviewView";

const { apiKeyState } = vi.hoisted(() => ({
    apiKeyState: {
        claude: { configured: true, source: "user" },
        gemini: { configured: false, source: null },
        openai: { configured: false, source: null },
        openrouter: { configured: false, source: null },
        vercel: { configured: false, source: null },
        "opencode-go": { configured: false, source: null },
        courtlistener: { configured: false, source: null },
    },
}));

// This file pins the ONE question server-owned generation asks of the client:
// who ends a run. Closing the socket no longer does — Stop is an endpoint, a
// reload attaches to the run the server reports, and a dropped stream resumes
// from the last frame it saw instead of replaying the grid.
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    MikeApiError: class MikeApiError extends Error {
        status: number;
        code: string | null;
        constructor(args: {
            message: string;
            status: number;
            code?: string | null;
        }) {
            super(args.message);
            this.name = "MikeApiError";
            this.status = args.status;
            this.code = args.code ?? null;
        }
    },
    clearTabularCells: vi.fn(),
    deleteTabularReview: vi.fn(),
    getTabularReview: vi.fn(),
    getProject: vi.fn(),
    getTabularReviewPeople: vi.fn(async () => ({ owner: null, members: [] })),
    getOllamaModels: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
    regenerateTabularCell: vi.fn(),
    stopTabularGeneration: vi.fn(async () => ({
        stopped: true,
        finished: false,
    })),
    streamTabularGeneration: vi.fn(),
    streamTabularGenerationResume: vi.fn(),
    updateTabularReview: vi.fn(async (_id: string, patch: unknown) => patch),
    uploadReviewDocument: vi.fn(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { apiKeys: apiKeyState },
        apiKeysDegraded: false,
    }),
}));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => [],
}));
vi.mock("../assistant/ModelToggle", () => ({
    SETTINGS_MODELS: [
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", group: "Anthropic" },
    ],
    ModelToggle: () => null,
}));
vi.mock("./TRTable", () => ({ TRTable: () => <div /> }));
vi.mock("./TRSidePanel", () => ({ TRSidePanel: () => null }));
vi.mock("./TRChatPanel", () => ({ TRChatPanel: () => null }));
vi.mock("./AddColumnModal", () => ({ AddColumnModal: () => null }));
vi.mock("./TRWorkflowModal", () => ({ TRWorkflowModal: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));
vi.mock("../modals/AccessModal", () => ({ AccessModal: () => null }));
vi.mock("./TabularReviewDetailsModal", () => ({
    TabularReviewDetailsModal: () => null,
}));

const ROW: TabularReviewRow = {
    id: "row-1",
    review_id: "r1",
    label: "Contract.pdf",
    row_type: "document",
    folder_id: null,
    library_folder_id: null,
    document_id: "doc-1",
    sort_index: 0,
    source_document_ids: ["doc-1"],
} as TabularReviewRow;

function review(over: Partial<TabularReview> = {}): TabularReview {
    return {
        id: "r1",
        project_id: null,
        user_id: "me",
        title: "Diligence",
        access_role: "editor",
        model: "claude-sonnet-5",
        columns_config: [{ index: 0, name: "Term", prompt: "Find it" }],
        document_ids: ["doc-1"],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        ...over,
    } as TabularReview;
}

function mockDetail(over: {
    review?: Partial<TabularReview>;
    active_generation?: { id: string; seq: number } | null;
}) {
    vi.mocked(getTabularReview).mockResolvedValue({
        review: review(over.review),
        cells: [],
        rows: [ROW],
        documents: [],
        active_generation: over.active_generation ?? null,
    });
}

/** An SSE response the test feeds frame by frame. */
function openStream() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
        },
    });
    return {
        response: new Response(body, { status: 200 }),
        push: (text: string) => controller.enqueue(encoder.encode(text)),
        done: () => {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
        fail: () => controller.error(new Error("connection reset")),
    };
}

describe("TabularReviewView server-owned generation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(stopTabularGeneration).mockResolvedValue({
            stopped: true,
            finished: false,
        });
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: true,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));
    });

    it("stops through the endpoint instead of dropping the stream", async () => {
        mockDetail({});
        const stream = openStream();
        vi.mocked(streamTabularGeneration).mockResolvedValue(stream.response);

        render(<TRView reviewId="r1" />);
        fireEvent.click(await screen.findByTitle("Run review"));

        // The run is live: the toolbar offers Stop.
        const stop = await screen.findByTitle("Stop generation");
        const signal = vi.mocked(streamTabularGeneration).mock.calls[0][2];
        fireEvent.click(stop);

        await waitFor(() =>
            expect(stopTabularGeneration).toHaveBeenCalledWith("r1"),
        );
        // Closing the socket would only detach this tab while the server kept
        // extracting, so Stop must NOT abort the request.
        expect(signal?.aborted).toBe(false);

        // The server ends the run; the client then reloads the settled review.
        stream.push('data: {"type":"cancelled"}\n\n');
        stream.done();
        await waitFor(() =>
            expect(screen.getByTitle("Run review")).toBeInTheDocument(),
        );
        expect(getTabularReview).toHaveBeenCalledTimes(2);
    });

    it("falls back to dropping the stream when the server has no run to stop", async () => {
        // An async (queue-backed) deployment, or another replica's run: there
        // is nothing in this process to stop, so Stop means what it used to.
        const { MikeApiError } = await import("@/app/lib/mikeApi");
        mockDetail({});
        const stream = openStream();
        vi.mocked(streamTabularGeneration).mockResolvedValue(stream.response);
        vi.mocked(stopTabularGeneration).mockRejectedValue(
            new MikeApiError({
                message: "no run",
                status: 404,
                code: "generation_not_found",
            }),
        );

        render(<TRView reviewId="r1" />);
        fireEvent.click(await screen.findByTitle("Run review"));
        const signal = vi.mocked(streamTabularGeneration).mock.calls[0][2];
        fireEvent.click(await screen.findByTitle("Stop generation"));

        await waitFor(() => expect(signal?.aborted).toBe(true));
    });

    it("attaches to a run the server still owns, with Stop offered", async () => {
        mockDetail({
            review: { is_running: true },
            active_generation: { id: "gen-1", seq: 4 },
        });
        const stream = openStream();
        vi.mocked(streamTabularGenerationResume).mockResolvedValue(
            stream.response,
        );

        render(<TRView reviewId="r1" />);

        // A reload attaches from the first frame — replaying cell updates is
        // idempotent — and the run is stoppable, so the button reads Stop.
        await waitFor(() =>
            expect(streamTabularGenerationResume).toHaveBeenCalledWith(
                "r1",
                expect.anything(),
                1,
            ),
        );
        expect(await screen.findByTitle("Stop generation")).toBeInTheDocument();

        stream.done();
        await waitFor(() =>
            expect(screen.getByTitle("Run review")).toBeInTheDocument(),
        );
    });

    it("only watches a lease it cannot stop", async () => {
        // `is_running` without `active_generation` is a run this process does
        // not own (the queue, or another replica). Attaching is all we can do.
        mockDetail({ review: { is_running: true } });
        const stream = openStream();
        vi.mocked(streamTabularGenerationResume).mockResolvedValue(
            stream.response,
        );

        render(<TRView reviewId="r1" />);

        await waitFor(() =>
            expect(streamTabularGenerationResume).toHaveBeenCalled(),
        );
        expect(screen.queryByTitle("Stop generation")).toBeNull();
        stream.done();
    });

    it("reconnects from the last frame it saw, not from the start", async () => {
        mockDetail({});
        const first = openStream();
        const resumed = openStream();
        vi.mocked(streamTabularGeneration).mockResolvedValue(first.response);
        vi.mocked(streamTabularGenerationResume).mockResolvedValue(
            resumed.response,
        );

        render(<TRView reviewId="r1" />);
        fireEvent.click(await screen.findByTitle("Run review"));
        await screen.findByTitle("Stop generation");

        first.push(
            'id: 5\ndata: {"type":"cell_update","row_id":"row-1","column_index":0,"content":null,"status":"generating"}\n\n',
        );
        await waitFor(() =>
            expect(
                vi.mocked(streamTabularGeneration).mock.calls.length,
            ).toBeGreaterThan(0),
        );
        first.fail();

        // Frames 1–5 are already applied, so the reconnect asks for 6 onwards.
        await waitFor(() =>
            expect(streamTabularGenerationResume).toHaveBeenCalledWith(
                "r1",
                expect.anything(),
                6,
            ),
        );
        resumed.done();
    });
});
