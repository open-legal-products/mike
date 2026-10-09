// This hook runs with mocked Office boundaries. The web test program does
// not load Office runtime declarations; this is the storage boundary used
// by the imported add-in modules, never a runtime shim.
declare global {
    const OfficeRuntime: {
        storage: {
            getItem(key: string): Promise<string | null>;
            setItem(key: string, value: string): Promise<void>;
            removeItem(key: string): Promise<void>;
        };
    };
}
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ stream: vi.fn(), resume: vi.fn(), notify: vi.fn(), info: vi.fn() }));
vi.mock('../../../word-addin/src/taskpane/api/stream', () => ({
    streamAssistant: mocks.stream, resumeAssistant: mocks.resume,
    WordChatStreamInterrupted: class extends Error {
    }, WordChatTerminalError: class extends Error {
    },
}));
vi.mock('../../../word-addin/src/taskpane/hooks/useWordDoc', () => ({ useWordDoc: () => ({ readDocumentMarkdown: async () => 'document' }) }));
vi.mock('../../../word-addin/src/taskpane/lib/errorReporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../word-addin/src/taskpane/api/mikeApi', () => ({ postWordChatToolResult: vi.fn(), stopWordChatTurn: vi.fn() }));
vi.mock('../../../word-addin/src/taskpane/lib/localWordChats', () => ({ saveLocalWordMessage: vi.fn(), setLocalWordChatActiveTurn: vi.fn() }));
vi.mock('../../../word-addin/src/taskpane/lib/wordDocumentIdentity', () => ({ readCurrentDocumentName: () => 'test.docx' }));
vi.mock('../../../word-addin/src/taskpane/lib/notify', async () => ({ ...(await import('@/shared/lib/userError')), notifyError: mocks.notify, notifyInfo: mocks.info }));
import { useWordAssistantChat } from '../../../word-addin/src/taskpane/hooks/useWordAssistantChat';
import { WordChatStreamInterrupted, WordChatTerminalError } from '../../../word-addin/src/taskpane/api/stream';
const submission = (content: string) => ({ content, model: 'gpt-5.4', reasoning: 'none' as const });
function setup() {
    return renderHook(({ sessionKey, documentId }) => useWordAssistantChat({ sessionKey, chatId: 'chat-1', initialMessages: [], onChatIdChange: vi.fn(), onChatStarted: vi.fn(), wordDocumentId: documentId, wordChatStorage: 'cloud', wordChatOwnerId: 'user-1', editApplyMode: 'direct', editController: { applyToolEdits: vi.fn().mockResolvedValue([]), processLiveRedlines: vi.fn(), markIncompleteRedlines: vi.fn(), waitForMessageEdits: vi.fn().mockResolvedValue(undefined) } }), { initialProps: { sessionKey: 1, documentId: "doc-1" } });
}
beforeEach(() => { vi.clearAllMocks(); mocks.stream.mockReset(); mocks.resume.mockReset(); });
it('an old failure Retry refuses after a newer successful turn', async () => {
    mocks.stream.mockRejectedValueOnce(new WordChatTerminalError('terminal failure')).mockResolvedValue(undefined);
    const { result } = setup();
    await act(async () => { await result.current.handleChat(submission('first failed prompt')); });
    const retry = mocks.notify.mock.calls[0][1].onRetry;
    expect(retry).toBeTypeOf('function');
    await act(async () => { await result.current.handleChat(submission('second successful prompt')); });
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    await act(async () => { retry(); });
    await waitFor(() => expect(result.current.isResponseLoading).toBe(false));
    expect(mocks.stream).toHaveBeenCalledTimes(2);
});
it('Retry on a known interrupted turn must not POST a fresh turn', async () => {
    mocks.stream.mockImplementationOnce(async (args) => { args.onMetadata({ chatId: 'chat-1', turnId: 'turn-1', assistantMessageId: 'answer-1' }); throw new WordChatStreamInterrupted(); }).mockResolvedValue(undefined);
    mocks.resume.mockRejectedValueOnce(new WordChatStreamInterrupted()).mockRejectedValueOnce(new WordChatStreamInterrupted()).mockResolvedValue(undefined);
    const { result } = setup();
    await act(async () => { await result.current.handleChat(submission('insert clause')); });
    const retry = mocks.notify.mock.calls[0][1].onRetry;
    await act(async () => { retry(); });
    await waitFor(() => expect(result.current.isResponseLoading).toBe(false));
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(mocks.resume).toHaveBeenCalledTimes(3);
    expect(result.current.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
});
it.each(['session change', 'document change', 'unmount'])('refuses a failed-turn Retry after %s', async (change) => {
    mocks.stream.mockRejectedValueOnce(new WordChatTerminalError('terminal failure')).mockResolvedValue(undefined);
    const hook = setup();
    await act(async () => { await hook.result.current.handleChat(submission('first')); });
    const retry = mocks.notify.mock.calls[0][1].onRetry;
    if (change === 'unmount')
        hook.unmount();
    else
        hook.rerender({ sessionKey: change === 'session change' ? 2 : 1, documentId: change === 'document change' ? 'doc-2' : 'doc-1' });
    await act(async () => { await retry(); });
    expect(mocks.stream).toHaveBeenCalledTimes(1);
});
it('offers no repost when delivery failed before turn metadata', async () => {
    mocks.stream.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = setup();
    await act(async () => { await result.current.handleChat(submission('insert clause')); });
    expect(mocks.notify.mock.calls[0][1].onRetry).toBeUndefined();
    expect(mocks.notify.mock.calls[0][0].message).toContain('may still be running');
});
