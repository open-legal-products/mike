import { useState } from "react";
import type { Story } from "@ladle/react";
import { CheckSquare } from "@/app/components/ui/check-square";
import { LIQUID_GLASS_MODAL_ROW_HOVER_CLASS } from "@/app/components/ui/liquid-surface";

const meta = { title: "UI / CheckSquare" };
export default meta;

/**
 * Decorative by default (`aria-hidden`), because the row around it owns the
 * interaction and the ARIA state. For a standalone control use a real
 * `<input type="checkbox">` with `TABLE_CHECKBOX_CLASS`.
 */
export const States: Story = () => (
    <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-2">
            <CheckSquare state="unchecked" /> unchecked
        </span>
        <span className="flex items-center gap-2">
            <CheckSquare state="checked" /> checked
        </span>
        <span className="flex items-center gap-2">
            <CheckSquare state="indeterminate" /> indeterminate
        </span>
        <span className="flex items-center gap-2">
            <CheckSquare state="unchecked" muted /> muted
        </span>
    </div>
);

/**
 * The realistic usage: a picker row that owns `role="checkbox"` and
 * `aria-checked`, with the square as the purely visual indicator.
 */
export const InAPickerRow: Story = () => {
    const [selected, setSelected] = useState<string[]>(["Exhibit A"]);
    const files = ["Exhibit A", "Exhibit B", "Deposition transcript"];

    return (
        <div className="max-w-sm">
            {files.map((file) => {
                const checked = selected.includes(file);

                return (
                    <div
                        key={file}
                        role="checkbox"
                        aria-checked={checked}
                        tabIndex={0}
                        onClick={() =>
                            setSelected((current) =>
                                checked
                                    ? current.filter((item) => item !== file)
                                    : [...current, file],
                            )
                        }
                        onKeyDown={(event) => {
                            if (event.key !== " " && event.key !== "Enter")
                                return;
                            event.preventDefault();
                            setSelected((current) =>
                                checked
                                    ? current.filter((item) => item !== file)
                                    : [...current, file],
                            );
                        }}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs text-gray-700 ${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40`}
                    >
                        <CheckSquare state={checked ? "checked" : "unchecked"} />
                        {file}
                    </div>
                );
            })}
        </div>
    );
};
