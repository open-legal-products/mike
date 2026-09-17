import { Input } from "@/app/components/ui/input";

const meta = { title: "UI / Input" };
export default meta;

/**
 * shadcn's input, on the semantic token set. For app forms prefer
 * `FormTextInput` from `form-field`, which carries the liquid-glass treatment.
 */
export const Default = () => (
    <div className="max-w-sm">
        <Input placeholder="Case caption" />
    </div>
);

export const Types = () => (
    <div className="flex max-w-sm flex-col gap-3">
        <Input type="text" placeholder="Text" />
        <Input type="email" placeholder="Email" />
        <Input type="password" placeholder="Password" />
        <Input type="number" placeholder="Number" />
        <Input type="file" />
    </div>
);

export const States = () => (
    <div className="flex max-w-sm flex-col gap-3">
        <Input placeholder="Default" />
        <Input defaultValue="Filled" />
        <Input placeholder="Disabled" disabled />
        <Input defaultValue="Invalid" aria-invalid />
    </div>
);
