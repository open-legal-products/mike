import { beforeEach, describe, expect, it, vi } from "vitest";

const { reportNetworkFailure, reportApiFailure } = vi.hoisted(() => ({
    reportNetworkFailure: vi.fn(),
    reportApiFailure: vi.fn(),
}));
vi.mock("../../../word-addin/src/taskpane/lib/errorReporting", () => ({
    reportNetworkFailure,
    reportApiFailure,
}));

import {
    configureMikeApiClient,
    listProjects,
    streamWordChat,
} from "../../../word-addin/src/taskpane/api/client";

const fetchMock = vi.fn<typeof fetch>();
const payload = {
    messages: [],
    document_id: "document-1",
    document_name: "Draft",
    storage: "local" as const,
    edit_apply_mode: "approval" as const,
};

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    configureMikeApiClient({
        baseUrl: "https://api.example.test",
        getAuthHeaders: async () => ({}),
        fetchImpl: fetchMock,
    });
});

describe("Word API transport cancellation", () => {
    it("preserves AbortError without wrapping or reporting it", async () => {
        const error = new DOMException("The operation was aborted", "AbortError");
        fetchMock.mockRejectedValueOnce(error);

        await expect(streamWordChat(payload)).rejects.toBe(error);

        expect(reportNetworkFailure).not.toHaveBeenCalled();
    });

    it.each([new Error("User stopped the response"), "navigation", null])(
        "preserves custom signal cancellation reason: %s",
        async (reason) => {
            const controller = new AbortController();
            fetchMock.mockImplementationOnce(async () => {
                controller.abort(reason);
                throw controller.signal.reason;
            });

            await expect(streamWordChat({
                ...payload,
                signal: controller.signal,
            })).rejects.toBe(reason);

            expect(reportNetworkFailure).not.toHaveBeenCalled();
        },
    );

    it("still reports and explains network failures when the signal is active", async () => {
        const error = new TypeError("Failed to fetch");
        fetchMock.mockRejectedValueOnce(error);

        await expect(streamWordChat({
            ...payload,
            signal: new AbortController().signal,
        })).rejects.toMatchObject({
            cause: error,
            message: expect.stringContaining("couldn't reach the server"),
            request: { method: "POST", url: "https://api.example.test/word-chat" },
        });

        expect(reportNetworkFailure).toHaveBeenCalledExactlyOnceWith(error, {
            method: "POST",
            url: "https://api.example.test/word-chat",
        });
    });

    it("reports failures for requests without a cancellation signal", async () => {
        const error = new TypeError("Failed to fetch");
        fetchMock.mockRejectedValueOnce(error);

        await expect(listProjects()).rejects.toMatchObject({ cause: error });

        expect(reportNetworkFailure).toHaveBeenCalledExactlyOnceWith(error, {
            method: "GET",
            url: "https://api.example.test/projects?view=summary",
        });
    });
});
