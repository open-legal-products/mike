import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import type { Project } from "../shared/types";
import { ProjectPickerModal } from "./ProjectPickerModal";

function Picker() {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    return <ProjectPickerModal
        open
        onClose={() => {}}
        projects={[
            { id: "first", name: "First matter", document_count: 3 },
            { id: "second", name: "Second matter", document_count: 5 },
        ] as Project[]}
        loading={false}
        selectedId={selectedId}
        onSelect={setSelectedId}
        breadcrumbs={["IDE", "Open project"]}
    />;
}

it("selects from the row or native checkbox and supports keyboard deselection", async () => {
    const user = userEvent.setup();
    render(<Picker />);
    const first = screen.getByRole("checkbox", { name: "Select First matter" });
    const second = screen.getByRole("checkbox", { name: "Select Second matter" });
    await user.click(screen.getByText("First matter"));
    expect(first).toBeChecked();
    expect(second).not.toBeChecked();
    await user.click(second);
    expect(second).toBeChecked();
    expect(first).not.toBeChecked();
    expect(second).toHaveFocus();
    await user.keyboard(" ");
    expect(second).not.toBeChecked();
    expect(second.closest("button")).toBeNull();
});
