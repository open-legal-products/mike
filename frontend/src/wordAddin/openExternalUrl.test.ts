import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "../../../word-addin/src/taskpane/lib/openExternalUrl";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * `window.open` as browsers implement it: with `noopener` (or `noreferrer`)
 * in the features it returns `null` even though the page opened.
 */
function browserOpen() {
    const opened = { opener: window as unknown } as Window;
    const open = vi.spyOn(window, "open").mockImplementation(
        (_url?: string | URL, _target?: string, features?: string) =>
            /noopener|noreferrer/.test(features ?? "") ? null : opened,
    );
    return { open, opened };
}

describe("opening links outside the Word pane", () => {
    const url = "https://app.example.test/settings/byok";
    const mailto = "mailto:support@example.test";

    it("uses the available Office bridge without opening a browser popup", () => {
        const openBrowserWindow = vi.fn();
        const open = vi.spyOn(window, "open");
        vi.stubGlobal("Office", { context: { ui: { openBrowserWindow } } });

        expect(openExternalUrl(url)).toBe(true);
        expect(openBrowserWindow).toHaveBeenCalledExactlyOnceWith(url);
        expect(open).not.toHaveBeenCalled();
    });

    it("never hands a mailto: to the Office bridge, which supports only http(s)", () => {
        const openBrowserWindow = vi.fn();
        vi.stubGlobal("Office", { context: { ui: { openBrowserWindow } } });
        const { open } = browserOpen();

        expect(openExternalUrl(mailto)).toBe(true);
        expect(openBrowserWindow).not.toHaveBeenCalled();
        expect(open).toHaveBeenCalledOnce();
    });

    it.each([undefined, {}, { context: {} }])(
        "falls back to the browser when the host bridge is absent: %s",
        (office) => {
            vi.stubGlobal("Office", office);
            const { open, opened } = browserOpen();

            // An opened page reports success, and still cannot reach the pane.
            expect(openExternalUrl(url)).toBe(true);
            expect(open).toHaveBeenCalledOnce();
            expect(opened.opener).toBeNull();
        },
    );

    it("reports a blocked handoff when both host and browser refuse it", () => {
        vi.stubGlobal("Office", {
            context: { ui: { openBrowserWindow: () => { throw new Error("blocked"); } } },
        });
        vi.spyOn(window, "open").mockReturnValue(null);

        expect(openExternalUrl(url)).toBe(false);
    });

    it("reports a browser exception as a blocked handoff", () => {
        vi.stubGlobal("Office", undefined);
        vi.spyOn(window, "open").mockImplementation(() => { throw new Error("blocked"); });

        expect(openExternalUrl(url)).toBe(false);
    });
});
