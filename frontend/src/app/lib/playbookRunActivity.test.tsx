import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    notifyPlaybookRunsChanged,
    playbookRunPath,
    setViewedPlaybookRun,
    subscribePlaybookRunChanges,
    useViewedPlaybookRun,
} from "./playbookRunActivity";

afterEach(() => setViewedPlaybookRun(null));

describe("playbook run activity", () => {
    it("notifies subscribers of run changes until they unsubscribe", () => {
        const listener = vi.fn();
        const unsubscribe = subscribePlaybookRunChanges(listener);
        notifyPlaybookRunsChanged();
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        notifyPlaybookRunsChanged();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("tracks the run on screen and re-renders only when it changes", () => {
        let renders = 0;
        const { result, unmount } = renderHook(() => {
            renders += 1;
            return useViewedPlaybookRun();
        });
        expect(result.current).toBeNull();
        act(() => setViewedPlaybookRun("run-1"));
        expect(result.current).toBe("run-1");
        const rendered = renders;
        act(() => setViewedPlaybookRun("run-1"));
        expect(renders).toBe(rendered);
        unmount();
        setViewedPlaybookRun("run-2");
        expect(renderHook(() => useViewedPlaybookRun()).result.current).toBe("run-2");
    });

    it("reads no viewed run while rendering on the server", () => {
        setViewedPlaybookRun("run-1");
        function ViewedRun() {
            return createElement("span", null, useViewedPlaybookRun() ?? "none");
        }
        expect(renderToString(createElement(ViewedRun))).toBe("<span>none</span>");
    });

    it("opens a run on its playbook's Runs tab with encoded IDs", () => {
        expect(playbookRunPath({ id: "run/1?x", playbookId: "pb/1" })).toBe(
            "/playbooks/pb%2F1?tab=runs&run=run%2F1%3Fx",
        );
    });
});
