import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlaybookAutosave } from "./usePlaybookAutosave";
import {
  updatePlaybook,
  type Playbook,
  type PlaybookContent,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
vi.mock("@/app/lib/mikeApi", () => ({ updatePlaybook: vi.fn() }));
vi.mock("@/app/lib/userFacingError", () => ({ notifyError: vi.fn() }));
const change = (name: string) => ({
  id: "book",
  content: { name } as PlaybookContent,
  access: { visibility: "private" as const },
});
const saved = (name: string) => ({ id: "book", name }) as Playbook;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());
describe("playbook autosave", () => {
  it("preserves pending edits to each playbook across rapid navigation", async () => {
    vi.mocked(updatePlaybook).mockImplementation(async (id, content) => (
      { id, name: content.name } as Playbook
    ));
    const onSaved = vi.fn();
    const { result } = renderHook(() => usePlaybookAutosave(onSaved));
    act(() => {
      result.current.schedule(change("First playbook"));
      result.current.schedule({ ...change("Other playbook"), id: "other" });
      result.current.schedule(change("Latest first playbook"));
    });
    await act(async () => { await result.current.flush(); });
    expect(vi.mocked(updatePlaybook).mock.calls).toEqual([
      ["book", { name: "Latest first playbook" }, change("").access],
      ["other", { name: "Other playbook" }, change("").access],
    ]);
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it("hides the saved acknowledgement after two seconds", async () => {
    vi.mocked(updatePlaybook).mockResolvedValue(saved("Updated"));
    const { result, unmount } = renderHook(() => usePlaybookAutosave(vi.fn()));
    act(() => result.current.schedule(change("Updated")));
    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.status).toBe("saved");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(result.current.status).toBe("saved");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.status).toBe("idle");
    unmount();
  });

  it("does not let an earlier acknowledgement hide a later save or error", async () => {
    const next = deferred<Playbook>();
    vi.mocked(updatePlaybook)
      .mockResolvedValueOnce(saved("First"))
      .mockReturnValueOnce(next.promise)
      .mockRejectedValueOnce(new Error("offline"));
    const { result, unmount } = renderHook(() => usePlaybookAutosave(vi.fn()));
    act(() => result.current.schedule(change("First")));
    await act(async () => {
      await result.current.flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    act(() => result.current.schedule(change("Second")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.status).toBe("saving");
    await act(async () => {
      next.resolve(saved("Second"));
      await result.current.flush();
    });
    expect(result.current.status).toBe("saved");
    act(() => result.current.schedule(change("Third")));
    await act(async () => {
      await result.current.flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.status).toBe("error");
    // Complete the retry before unmount, which deliberately flushes pending edits.
    vi.mocked(updatePlaybook).mockResolvedValueOnce(saved("Third"));
    await act(async () => {
      await result.current.flush();
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("debounces typing and serializes newer edits behind an in-flight save", async () => {
    const first = deferred<Playbook>();
    vi.mocked(updatePlaybook)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(saved("Newest"));
    const onSaved = vi.fn();
    const { result } = renderHook(() => usePlaybookAutosave(onSaved));
    act(() => {
      result.current.schedule(change("Old"));
      result.current.schedule(change("First"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(updatePlaybook).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.schedule(change("Newest"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(updatePlaybook).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve(saved("First"));
      await result.current.flush();
    });
    expect(updatePlaybook).toHaveBeenLastCalledWith(
      "book",
      { name: "Newest" },
      change("").access,
    );
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(saved("Newest"));
    expect(result.current.status).toBe("saved");
  });
  it("keeps failed changes and retries the current content", async () => {
    vi.mocked(updatePlaybook)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(saved("Current"));
    const { result } = renderHook(() => usePlaybookAutosave(vi.fn()));
    act(() => result.current.schedule(change("First")));
    await act(async () => {
      expect(await result.current.flush()).toBe(false);
    });
    expect(result.current.status).toBe("error");
    act(() => result.current.schedule(change("Current")));
    await act(async () => {
      vi.mocked(notifyError).mock.calls[0][1]?.onRetry?.();
      await result.current.flush();
    });
    expect(updatePlaybook).toHaveBeenLastCalledWith(
      "book",
      { name: "Current" },
      change("").access,
    );
    expect(result.current.status).toBe("saved");
  });
  it("drops a cancelled playbook's waiting edit and keeps the others", async () => {
    vi.mocked(updatePlaybook).mockImplementation(async (id, content) => (
      { id, name: content.name } as Playbook
    ));
    const { result, unmount } = renderHook(() => usePlaybookAutosave(vi.fn()));
    act(() => {
      result.current.schedule(change("Before the import"));
      result.current.schedule({ ...change("Other playbook"), id: "other" });
      // The import finished and replaced this playbook's content.
      result.current.cancel("book");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(vi.mocked(updatePlaybook).mock.calls).toEqual([
      ["other", { name: "Other playbook" }, change("").access],
    ]);
    unmount();
  });
  it("flushes the trailing edit when navigation unmounts the editor", async () => {
    vi.mocked(updatePlaybook).mockResolvedValue(saved("Last edit"));
    const { result, unmount } = renderHook(() => usePlaybookAutosave(vi.fn()));
    act(() => result.current.schedule(change("Last edit")));
    unmount();
    await act(async () => {});
    expect(updatePlaybook).toHaveBeenCalledExactlyOnceWith(
      "book",
      { name: "Last edit" },
      change("").access,
    );
  });
});
