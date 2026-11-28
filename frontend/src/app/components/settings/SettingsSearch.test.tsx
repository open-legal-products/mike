import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_SEARCH_ENTRIES } from "@/app/lib/settingsSearch";
import { SettingsSearch } from "./SettingsSearch";

const push = vi.fn();
const navigation = vi.hoisted(() => ({ pathname: "/settings" }));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
    usePathname: () => navigation.pathname,
}));

// The search is a page-header button that opens into a box.
const openSearch = () =>
    fireEvent.click(screen.getByRole("button", { name: "Search settings" }));

describe("SettingsSearch", () => {
    it("as a field, is an open box from the start that stays open when left empty", async () => {
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} variant="field" />);

        const box = screen.getByRole("searchbox", { name: "Search settings" });
        expect(box).not.toHaveFocus();
        expect(
            screen.queryByRole("button", { name: "Search settings" }),
        ).not.toBeInTheDocument();
        await user.click(box);
        await user.keyboard("{Escape}");
        await user.tab();
        expect(
            screen.getByRole("searchbox", { name: "Search settings" }),
        ).toBeInTheDocument();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        navigation.pathname = "/settings";
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("is a header button that opens into a focused box, listing nothing until something is typed", () => {
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        expect(screen.queryByRole("searchbox")).toBeNull();
        openSearch();
        expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveFocus();
        expect(screen.queryByRole("group", { name: "Settings search results" })).toBeNull();
    });

    it("folds back into the button when left empty, and on Escape returns focus to it", async () => {
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        openSearch();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("searchbox")).toBeNull();
        expect(screen.getByRole("button", { name: "Search settings" })).toHaveFocus();
    });

    it("lists nothing until three characters are typed", async () => {
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        openSearch();
        await user.type(screen.getByRole("searchbox"), "me");
        expect(screen.queryByRole("group", { name: "Settings search results" })).toBeNull();
        await user.type(screen.getByRole("searchbox"), "m");
        expect(screen.getByRole("group", { name: "Settings search results" })).toBeInTheDocument();
    });

    it("lists name matches before related ones, each under its own heading", async () => {
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        openSearch();
        await user.type(screen.getByRole("searchbox"), "memory");

        const matches = screen.getByRole("group", { name: "Matches" });
        const related = screen.getByRole("group", { name: "Related" });
        expect(matches.compareDocumentPosition(related) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The tab trail is left off when it would only repeat the title.
        expect(screen.getByRole("button", { name: "Memory" })).toBeInTheDocument();
        // Breadcrumb style, section first, without the description.
        const file = screen.getByRole("button", { name: "Memory file, Memory" });
        expect(file).toHaveTextContent(/^MemoryMemory file$/);
        expect(file).not.toHaveTextContent("Whether");
        expect(screen.getByRole("status")).toHaveTextContent(/settings found/);
    });

    it("finds API Keys from 'api key' and opens it on Enter", async () => {
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        openSearch();
        const input = screen.getByRole("searchbox");
        await user.type(input, "api key");
        expect(screen.getByRole("button", { name: /^API Keys/ })).toBeInTheDocument();

        await user.keyboard("{Enter}");
        expect(push).toHaveBeenCalledWith("/settings/byok");
        // The query is cleared and the box folds back into its button.
        expect(input).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Search settings" })).toBeInTheDocument();
        expect(screen.queryByRole("group", { name: "Settings search results" })).toBeNull();
    });

    it("moves through results with the arrow keys and opens one with a click", async () => {
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        openSearch();
        await user.type(screen.getByRole("searchbox"), "delete");

        await user.keyboard("{ArrowDown}");
        const first = screen.getAllByRole("button").find((b) => b.hasAttribute("data-settings-result"));
        expect(first).toHaveFocus();
        await user.keyboard("{ArrowDown}");
        expect(first).not.toHaveFocus();
        await user.keyboard("{ArrowUp}{ArrowUp}");
        expect(screen.getByRole("searchbox")).toHaveFocus();

        await user.click(screen.getByRole("button", { name: /^Delete account/ }));
        expect(push).toHaveBeenCalledWith("/settings/account#danger-zone");
    });

    it("focuses a section even when navigation takes longer than the former three-second deadline", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const scrollIntoView = vi.fn();
        Element.prototype.scrollIntoView = scrollIntoView;
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        openSearch();
        await user.type(screen.getByRole("searchbox"), "password");
        await user.click(screen.getByRole("button", { name: /^Password/ }));
        expect(push).toHaveBeenCalledWith("/settings/security#password");

        // A cold route or slow request has not mounted the heading after five seconds.
        const heading = document.createElement("h2");
        heading.id = "password";
        act(() => {
            vi.advanceTimersByTime(5_000);
        });
        await act(async () => { document.body.appendChild(heading); });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(heading).toHaveFocus();
        heading.remove();
    });

    it("stops looking for the section when the box goes away first", async () => {
        // An unmounted search must not steal focus when a later page mounts
        // a heading with the same id.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const lookups = vi.spyOn(document, "getElementById");
        const { unmount } = render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        openSearch();
        await user.type(screen.getByRole("searchbox"), "delete");
        await user.click(screen.getByRole("button", { name: /^Delete account/ }));
        expect(push).toHaveBeenCalledWith("/settings/account#danger-zone");

        unmount();
        const before = lookups.mock.calls.length;
        const heading = document.createElement("h2");
        heading.id = "danger-zone";
        await act(async () => { document.body.appendChild(heading); });
        expect(lookups.mock.calls.length).toBe(before);
        expect(heading).not.toHaveFocus();
        heading.remove();
        lookups.mockRestore();
    });

    it("cancels a pending heading when navigation goes somewhere else", async () => {
        const user = userEvent.setup();
        const view = render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        openSearch();
        await user.type(screen.getByRole("searchbox"), "password");
        await user.keyboard("{Enter}");
        navigation.pathname = "/settings/appearance";
        view.rerender(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        const heading = document.createElement("h2");
        heading.id = "password";
        await act(async () => { document.body.appendChild(heading); });
        expect(heading).not.toHaveFocus();
        heading.remove();
    });

    it("keeps focus in the box when the pointer presses inside the list", async () => {
        // Safari and Firefox do not focus a button on mousedown, so without
        // this the box would blur, the list would unmount and the click would
        // never reach the result.
        const user = userEvent.setup();
        render(<SettingsSearch entries={SETTINGS_SEARCH_ENTRIES} />);
        openSearch();
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
        openSearch();
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
        openSearch();
        await user.type(screen.getByRole("searchbox"), "export");
        expect(screen.queryByRole("button", { name: /^Export data/ })).toBeNull();
    });
});
