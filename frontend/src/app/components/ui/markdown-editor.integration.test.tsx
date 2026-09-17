import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./markdown-editor";

// Exercise the real Tiptap parser/serializer: memory is commonly generated
// with list indentation and markers that differ from the editor's output.
describe("MarkdownEditor with real Markdown content", () => {
  it("opens project memory in rich mode and switches between modes without saving on view", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MarkdownEditor
        value={
          "# Project memory\n\n* __Client__: Acme\n* Deadline: Friday\n  * Draft due: Thursday\n\nContext\n-------\n\nThe client prefers _short drafts_."
        }
        onChange={onChange}
        ariaLabel="Project memory"
        allowTables={false}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show raw Markdown" }),
      ).toBeVisible(),
    );
    // Wait for the deferred round-trip check as well as editor creation.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(
      screen.queryByRole("textbox", { name: "Project memory (raw Markdown)" }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Project memory" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Show raw Markdown" }));
    expect(
      screen.getByRole("textbox", { name: "Project memory (raw Markdown)" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show rich editor" }));
    expect(
      screen.getByRole("heading", { name: "Project memory" }),
    ).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps unsupported images intact when rich mode is requested", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const source =
      "# Project memory\n\n![Diagram](diagram.png)\n\nKeep this diagram.";
    render(
      <MarkdownEditor
        value={source}
        onChange={onChange}
        ariaLabel="Project memory"
        allowTables={false}
      />,
    );

    expect(
      await screen.findByRole("textbox", {
        name: "Project memory (raw Markdown)",
      }),
    ).toHaveValue(source);
    await user.click(screen.getByRole("button", { name: "Show rich editor" }));
    expect(
      screen.getByRole("textbox", { name: "Project memory (raw Markdown)" }),
    ).toHaveValue(source);
    expect(onChange).not.toHaveBeenCalled();
  });
});
