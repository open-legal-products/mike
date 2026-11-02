import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuditActors, type AuditActor } from "@/app/lib/mikeApi";
import { HistoryActorFilter } from "./HistoryActorFilter";

vi.mock("@/app/lib/mikeApi", () => ({ getAuditActors: vi.fn() }));
const getActors = vi.mocked(getAuditActors);
const person = (id: string, name = `Person ${id}`): AuditActor => ({
  user_id: id,
  display_name: name,
  email: `${id}@example.com`,
  profile_photo: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  getActors.mockResolvedValue({ users: [person("1")], nextOffset: null });
});
const trigger = () => screen.getByRole("button", { name: "Filter by person" });

describe("HistoryActorFilter", () => {
  it("loads on opening, searches by name or email, and selects an exact identity", async () => {
    const onChange = vi.fn(),
      user = userEvent.setup();
    render(<HistoryActorFilter orgId="org" value={null} onChange={onChange} />);
    expect(getActors).not.toHaveBeenCalled();
    await user.click(trigger());
    expect(
      await screen.findByRole("button", { name: /Person 1.*1@example.com/ }),
    ).toBeVisible();
    const input = screen.getByRole("searchbox", { name: "Search people" });
    expect(input).toHaveFocus();
    getActors.mockResolvedValue({
      users: [person("2", "Jamie Morgan")],
      nextOffset: null,
    });
    await user.type(input, "jamie");
    await user.click(
      await screen.findByRole("button", {
        name: /Jamie Morgan.*2@example.com/,
      }),
    );
    expect(getActors).toHaveBeenLastCalledWith(
      { orgId: "org", search: "jamie", offset: 0 },
      expect.any(AbortSignal),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      person("2", "Jamie Morgan"),
    );
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("appends pages on scroll and offers a keyboard-accessible load more button", async () => {
    getActors
      .mockResolvedValueOnce({ users: [person("1")], nextOffset: 20 })
      .mockResolvedValueOnce({ users: [person("2")], nextOffset: 40 })
      .mockResolvedValueOnce({ users: [person("3")], nextOffset: null });
    render(<HistoryActorFilter orgId="org" value={null} onChange={vi.fn()} />);
    await userEvent.click(trigger());
    await screen.findByRole("button", { name: "Load more people" });
    const list = screen.getByRole("group", { name: "People" });
    expect(list).toHaveClass("max-h-72", "overflow-y-auto");
    fireEvent.scroll(list, { target: { scrollTop: 100 } });
    await screen.findByRole("button", { name: /Person 2.*2@example.com/ });
    await userEvent.click(
      screen.getByRole("button", { name: "Load more people" }),
    );
    await screen.findByRole("button", { name: /Person 3.*3@example.com/ });
    expect(getActors.mock.calls.map(([query]) => query.offset)).toEqual([
      0, 20, 40,
    ]);
    expect(within(list).getAllByRole("button")).toHaveLength(4);
  });

  it("discards stale searches, resets pagination, and cancels requests on close", async () => {
    let finish!: (value: {
      users: AuditActor[];
      nextOffset: number | null;
    }) => void;
    getActors.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<HistoryActorFilter orgId="org" value={null} onChange={vi.fn()} />);
    await userEvent.click(trigger());
    await waitFor(() => expect(getActors).toHaveBeenCalledOnce());
    const signal = getActors.mock.calls[0][1]!;
    getActors.mockResolvedValue({ users: [person("2")], nextOffset: null });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "New" },
    });
    await screen.findByRole("button", { name: /Person 2.*2@example.com/ });
    expect(signal.aborted).toBe(true);
    finish({ users: [person("1")], nextOffset: 20 });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("Person 1")).not.toBeInTheDocument();
    expect(getActors.mock.calls[1][0].offset).toBe(0);
  });

  it("retries a failed next page without losing earlier people or changing the selection", async () => {
    getActors
      .mockResolvedValueOnce({ users: [person("1")], nextOffset: 20 })
      .mockRejectedValueOnce(new Error("internal secret"))
      .mockResolvedValueOnce({ users: [person("2")], nextOffset: null });
    const onChange = vi.fn();
    render(
      <HistoryActorFilter
        orgId="org"
        value={person("1")}
        onChange={onChange}
      />,
    );
    await userEvent.click(trigger());
    await userEvent.click(
      await screen.findByRole("button", { name: "Load more people" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load people.",
    );
    expect(screen.queryByText("internal secret")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Person 1.*1@example.com/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: /Person 2.*2@example.com/ });
    expect(getActors.mock.calls.map(([query]) => query.offset)).toEqual([
      0, 20, 20,
    ]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears the selected person and supports keyboard navigation", async () => {
    const user = userEvent.setup(),
      onChange = vi.fn();
    render(
      <HistoryActorFilter
        orgId="org"
        value={person("1")}
        onChange={onChange}
      />,
    );
    await user.click(trigger());
    await screen.findByRole("button", { name: /Person 1.*1@example.com/ });
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "All people" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("button", { name: /Person 1.*1@example.com/ }),
    ).toHaveFocus();
    await user.keyboard("{Home}{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });
});
