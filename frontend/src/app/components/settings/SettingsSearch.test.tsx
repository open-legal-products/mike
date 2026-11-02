import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_SEARCH_ENTRIES } from "@/app/lib/settingsSearch";
import { SettingsSearch } from "./SettingsSearch";

const push = vi.fn();

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
}));

describe("SettingsSearch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("shows nothing until something is typed", () => {
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeInTheDocument();
        expect(screen.queryByRole("group", { name: "Settings search results" })).toBeNull();
    });

    it("lists name matches before related ones, each under its own heading", async () => {
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        await user.type(screen.getByRole("searchbox"), "memory");

        const matches = screen.getByRole("group", { name: "Matches" });
        const related = screen.getByRole("group", { name: "Related" });
        expect(matches.compareDocumentPosition(related) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The tab trail is left off when it would only repeat the title.
        expect(screen.getByRole("button", { name: /^Memory\. Whether/ })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /^Memory file, Memory\./ })).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent(/settings found/);
    });

    it("finds Bring Your Own Keys from 'api key' and opens it on Enter", async () => {
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        const input = screen.getByRole("searchbox");
        await user.type(input, "api key");
        expect(screen.getByRole("button", { name: /^Bring Your Own Keys/ })).toBeInTheDocument();

        await user.keyboard("{Enter}");
        expect(push).toHaveBeenCalledWith("/settings/byok");
        expect(input).toHaveValue("");
        expect(screen.queryByRole("group", { name: "Settings search results" })).toBeNull();
    });

    it("moves through results with the arrow keys and opens one with a click", async () => {
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        await user.type(screen.getByRole("searchbox"), "delete");

        await user.keyboard("{ArrowDown}");
        const first = screen.getAllByRole("button").find((b) => b.hasAttribute("data-settings-result"));
        expect(first).toHaveFocus();
        await user.keyboard("{ArrowDown}");
        expect(first).not.toHaveFocus();
        await user.keyboard("{ArrowUp}{ArrowUp}");
        expect(screen.getByRole("searchbox")).toHaveFocus();

        await user.click(screen.getByRole("button", { name: /^Delete account/ }));
        expect(push).toHaveBeenCalledWith("/settings#danger-zone");
    });

    it("scrolls to the section once its heading exists", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const scrollIntoView = vi.fn();
        Element.prototype.scrollIntoView = scrollIntoView;
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        await user.type(screen.getByRole("searchbox"), "password");
        await user.click(screen.getByRole("button", { name: /^Password/ }));
        expect(push).toHaveBeenCalledWith("/settings/security#password");

        // The page draws its heading a moment after navigation.
        const heading = document.createElement("h2");
        heading.id = "password";
        act(() => {
            vi.advanceTimersByTime(250);
        });
        document.body.appendChild(heading);
        act(() => {
            vi.advanceTimersByTime(250);
        });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(heading).toHaveFocus();
        heading.remove();
    });

    it("stops looking for the section when the box goes away first", async () => {
        // A page is torn down (or the person leaves Settings) while the poll
        // for the chosen heading is still running; it must not keep touching
        // the document, as it did in CI after the test's DOM was gone.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const lookups = vi.spyOn(document, "getElementById");
        const { unmount } = render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        await user.type(screen.getByRole("searchbox"), "delete");
        await user.click(screen.getByRole("button", { name: /^Delete account/ }));
        expect(push).toHaveBeenCalledWith("/settings#danger-zone");

        unmount();
        const before = lookups.mock.calls.length;
        act(() => {
            vi.advanceTimersByTime(5_000);
        });
        expect(lookups.mock.calls.length).toBe(before);
        lookups.mockRestore();
    });

    it("keeps focus in the box when the pointer presses inside the list", async () => {
        // Safari and Firefox do not focus a button on mousedown, so without
        // this the box would blur, the list would unmount and the click would
        // never reach the result.
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        const input = screen.getByRole("searchbox");
        await user.type(input, "dark");
        const list = screen.getByRole("group", { name: "Settings search results" });

        const notPrevented = fireEvent.mouseDown(list.parentElement!);
        expect(notPrevented).toBe(false);
        expect(input).toHaveFocus();
        expect(list).toBeInTheDocument();
    });

    it("says when nothing matches", async () => {
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        await user.type(screen.getByRole("searchbox"), "zzzz");
        expect(screen.getByText(/No settings match/)).toBeInTheDocument();
    });

    it("searches only the entries it is given", async () => {
        const user = userEvent.setup();
        render(
            <SettingsSearch
                entries={SETTINGS_SEARCH_ENTRIES.filter((entry) => entry.tabId !== "privacy-data")}
            />,
        );
        await user.type(screen.getByRole("searchbox"), "export");
        expect(screen.queryByRole("button", { name: /^Export data/ })).toBeNull();
    });
});
