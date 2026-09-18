import { describe, expect, it, vi } from "vitest";
import { getChat } from "./mikeApi";
import { beginAssistantTurn, cancelAssistantTurn, hasAssistantTurn, loadAssistantChat } from "./assistantTurns";
vi.mock("./mikeApi", () => ({ getChat: vi.fn() }));
const getChatMock = vi.mocked(getChat);
const history = { chat: { id: "a" }, messages: [{ role: "assistant", content: "Finished" }] } as Awaited<ReturnType<typeof getChat>>;

describe("assistant turn history loading", () => {
  it("waits for its own turn, without delaying an unrelated chat", async () => {
    getChatMock.mockResolvedValue(history);
    const turn = beginAssistantTurn("a", vi.fn());
    try {
      const waiting = loadAssistantChat("a");
      await loadAssistantChat("b");
      expect(getChatMock).not.toHaveBeenCalledWith("a");
      turn.finish();
      expect(await waiting).toEqual(history);
    } finally { turn.finish(); getChatMock.mockReset(); }
  });
  it("discards history when a turn starts and finishes during the GET", async () => {
    let finishRead!: (value: typeof history) => void;
    getChatMock.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    getChatMock.mockResolvedValue(history);
    const read = loadAssistantChat("a");
    const turn = beginAssistantTurn("a", vi.fn());
    turn.finish();
    finishRead({ ...history, messages: [] });
    expect((await read).messages).toEqual(history.messages);
    expect(getChatMock).toHaveBeenCalledTimes(2);
    getChatMock.mockReset();
  });
  it("retries an invalidated GET even when that stale read fails", async () => {
    let rejectRead!: (error: Error) => void;
    getChatMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    getChatMock.mockResolvedValue(history);
    const read = loadAssistantChat("a");
    const turn = beginAssistantTurn("a", vi.fn());
    turn.finish();
    rejectRead(new Error("stale read failed"));
    expect(await read).toEqual(history);
    getChatMock.mockReset();
  });
  it("propagates load failures and permits retry after completion", async () => {
    getChatMock.mockRejectedValueOnce(new Error("offline"));
    await expect(loadAssistantChat("a")).rejects.toThrow("offline");
    getChatMock.mockResolvedValue(history);
    expect(await loadAssistantChat("a")).toEqual(history);
    getChatMock.mockReset();
  });
  it("waits for the cancellation row when Stop closes the socket before persistence", async () => {
    getChatMock.mockResolvedValueOnce({ ...history, messages: [] });
    const saved = { ...history, messages: [{ ...history.messages[0], id: "stopped-answer" }] };
    getChatMock.mockResolvedValue(saved);
    const turn = beginAssistantTurn("a", vi.fn());
    turn.identify("a", "stopped-answer");
    const read = loadAssistantChat("a");
    cancelAssistantTurn("a");
    turn.finish();
    expect(await read).toEqual(saved);
    expect(getChatMock).toHaveBeenCalledTimes(2);
    getChatMock.mockReset();
  });
  it("keeps Stop associated with the detached request", () => {
    const cancel = vi.fn();
    const turn = beginAssistantTurn("a", cancel);
    cancelAssistantTurn("b");
    expect(cancel).not.toHaveBeenCalled();
    cancelAssistantTurn("a");
    expect(cancel).toHaveBeenCalledOnce();
    turn.finish();
    expect(hasAssistantTurn("a")).toBe(false);
  });
  it("gives up when the server never stores the response", async () => {
    // Stop closes the socket; if the backend then fails to write the row, the
    // reader must surface a load error instead of polling for it forever.
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(0).mockReturnValue(10_000);
    getChatMock.mockResolvedValue({ ...history, messages: [] });
    const turn = beginAssistantTurn("a", vi.fn());
    turn.identify("a", "never-saved");
    const read = loadAssistantChat("a");
    turn.finish();
    await expect(read).rejects.toThrow("Chat response could not be loaded");
    now.mockRestore();
    getChatMock.mockReset();
  });
  it("ignores turns, identities and reads that belong to another chat", async () => {
    const cancel = vi.fn();
    cancelAssistantTurn(undefined);
    expect(cancel).not.toHaveBeenCalled();
    // A turn with no chat id yet is registered only once the stream names one.
    const anonymous = beginAssistantTurn(undefined, cancel);
    expect(hasAssistantTurn(undefined)).toBe(false);
    anonymous.finish();
    // identify() after finish must not resurrect the turn.
    anonymous.identify("a", "late");
    expect(hasAssistantTurn("a")).toBe(false);

    let finishRead!: (value: typeof history) => void;
    getChatMock.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const read = loadAssistantChat("a");
    // Another chat's turn starting mid-GET must not invalidate this read.
    const other = beginAssistantTurn("b", vi.fn());
    finishRead(history);
    expect(await read).toEqual(history);
    expect(getChatMock).toHaveBeenCalledTimes(1);
    other.finish();
    getChatMock.mockReset();
  });
});
