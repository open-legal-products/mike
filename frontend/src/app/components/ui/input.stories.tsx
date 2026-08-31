import type { Story } from "@ladle/react";
import { Input } from "@/app/components/ui/input";

export default { title: "UI / Input" };

/**
 * shadcn's input, on the semantic token set. For app forms prefer
 * `FormTextInput` from `form-field`, which carries the liquid-glass treatment.
 */
export const Default: Story = () => (
    <div className="max-w-sm">
        <Input placeholder="Case caption" />
    </div>
);

export const Types: Story = () => (
    <div className="flex max-w-sm flex-col gap-3">
        <Input type="text" placeholder="Text" />
        <Input type="email" placeholder="Email" />
        <Input type="password" placeholder="Password" />
        <Input type="number" placeholder="Number" />
        <Input type="file" />
    </div>
);

export const States: Story = () => (
    <div className="flex max-w-sm flex-col gap-3">
        <Input placeholder="Default" />
        <Input defaultValue="Filled" />
        <Input placeholder="Disabled" disabled />
        <Input defaultValue="Invalid" aria-invalid />
    </div>
);
