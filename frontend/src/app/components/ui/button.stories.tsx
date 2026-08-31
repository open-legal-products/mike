import type { Story } from "@ladle/react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/app/components/ui/button";

export default { title: "UI / Button" };

export const Variants: Story = () => (
    <div className="flex flex-wrap items-center gap-3">
        <Button type="button">Default</Button>
        <Button type="button" variant="secondary">
            Secondary
        </Button>
        <Button type="button" variant="outline">
            Outline
        </Button>
        <Button type="button" variant="ghost">
            Ghost
        </Button>
        <Button type="button" variant="destructive">
            Destructive
        </Button>
        <Button type="button" variant="link">
            Link
        </Button>
    </div>
);

export const Sizes: Story = () => (
    <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm">
            Small
        </Button>
        <Button type="button">Default</Button>
        <Button type="button" size="lg">
            Large
        </Button>
        <Button type="button" size="icon" aria-label="Continue">
            <ArrowRight aria-hidden="true" />
        </Button>
    </div>
);

export const Disabled: Story = () => (
    <Button type="button" disabled>
        Disabled
    </Button>
);

/**
 * `Button` has no `type` default, so every instance inside a `<form>` must set
 * `type="button"` or it submits. That is the single most common bug with this
 * primitive — see docs/design-system.md.
 */
export const InsideAForm: Story = () => (
    <form
        className="flex items-center gap-3"
        onSubmit={(event) => event.preventDefault()}
    >
        <Button type="submit">Submit (intentional)</Button>
        <Button type="button" variant="outline">
            Cancel (type=&quot;button&quot;)
        </Button>
    </form>
);
