import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "../../../word-addin/src/taskpane/lib/openExternalUrl";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("opening links outside the Word pane", () => {
    const url = "mailto:support@example.test";

    it("uses the available Office bridge without opening a browser popup", () => {
        const openBrowserWindow = vi.fn();
        const open = vi.spyOn(window, "open");
        vi.stubGlobal("Office", { context: { ui: { openBrowserWindow } } });

        expect(openExternalUrl(url)).toBe(true);
        expect(openBrowserWindow).toHaveBeenCalledExactlyOnceWith(url);
        expect(open).not.toHaveBeenCalled();
    });

    it.each([undefined, {}, { context: {} }])(
        "falls back to the browser when the host bridge is absent: %s",
        (office) => {
            vi.stubGlobal("Office", office);
            const open = vi.spyOn(window, "open").mockReturnValue(window);

            expect(openExternalUrl(url)).toBe(true);
            expect(open).toHaveBeenCalledExactlyOnceWith(
                url, "_blank", "noopener,noreferrer",
            );
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
