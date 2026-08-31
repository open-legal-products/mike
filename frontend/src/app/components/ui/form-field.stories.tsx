import type { Story } from "@ladle/react";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";

export default { title: "UI / FormField" };

/** The glass variant is the default app form control. */
export const GlassField: Story = () => (
    <div className="max-w-sm">
        <FieldLabel htmlFor="matter-name">Matter name</FieldLabel>
        <FormTextInput id="matter-name" placeholder="Acme v. Widget Co." />
    </div>
);

/** The minimal variant is the large serif title field used on document pages. */
export const MinimalField: Story = () => (
    <div className="max-w-sm">
        <FieldLabel htmlFor="doc-title">Document title</FieldLabel>
        <FormTextInput
            id="doc-title"
            variant="minimal"
            placeholder="Untitled document"
        />
    </div>
);

export const States: Story = () => (
    <div className="flex max-w-sm flex-col gap-4">
        <FormTextInput placeholder="Empty" aria-label="Empty" />
        <FormTextInput defaultValue="Filled" aria-label="Filled" />
        <FormTextInput placeholder="Disabled" aria-label="Disabled" disabled />
    </div>
);

/**
 * `FieldLabel` is element-agnostic. Use `as="p"` or `as="span"` when the group
 * it names is not a single form control, and point `aria-labelledby` at its
 * `id` instead of relying on `htmlFor`.
 */
export const LabelAsNonLabelElement: Story = () => (
    <fieldset className="max-w-sm border-0 p-0">
        <FieldLabel as="p" id="export-format-label">
            Export format
        </FieldLabel>
        <div
            role="group"
            aria-labelledby="export-format-label"
            className="flex gap-3 text-sm"
        >
            <label className="flex items-center gap-1.5">
                <input type="radio" name="format" defaultChecked /> DOCX
            </label>
            <label className="flex items-center gap-1.5">
                <input type="radio" name="format" /> PDF
            </label>
        </div>
    </fieldset>
);
