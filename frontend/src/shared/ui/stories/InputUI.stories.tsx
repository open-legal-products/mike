import { InputUI } from "@/shared/ui/InputUI";

const meta = { title: "Shared UI / Input" };
export default meta;

/**
 * shadcn's input, on the semantic token set. For app forms prefer
 * `FormTextInput` from `form-field`, which carries the liquid-glass treatment.
 */
export const Default = () => (
    <div className="max-w-sm">
        <InputUI placeholder="Case caption" />
    </div>
);

export const Types = () => (
    <div className="flex max-w-sm flex-col gap-3">
        <InputUI type="text" placeholder="Text" />
        <InputUI type="email" placeholder="Email" />
        <InputUI type="password" placeholder="Password" />
        <InputUI type="number" placeholder="Number" />
        <InputUI type="file" />
    </div>
);

export const States = () => (
    <div className="flex max-w-sm flex-col gap-3">
        <InputUI placeholder="Default" />
        <InputUI defaultValue="Filled" />
        <InputUI placeholder="Disabled" disabled />
        <InputUI defaultValue="Invalid" aria-invalid />
    </div>
);
