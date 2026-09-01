import type { Story } from "@ladle/react";
import { CiteButton } from "@/app/components/ui/cite-button";

const meta = { title: "UI / CiteButton" };
export default meta;

const QUOTE =
    "The parties agree that this Agreement shall be governed by the laws of the State of New York.";

/**
 * Copies the quote plus its citation to the clipboard and flips to a
 * confirmation for two seconds. Click it to see the copied state.
 */
export const WithLabel: Story = () => (
    <CiteButton quoteText={QUOTE} quoteLabel="Master Agreement § 12.1" />
);

/**
 * With the text hidden the control becomes icon-only, so it sets an
 * `aria-label`. It deliberately does *not* set one when the label is visible —
 * naming a control something other than its visible text breaks WCAG 2.5.3.
 */
export const IconOnly: Story = () => (
    <CiteButton
        quoteText={QUOTE}
        quoteLabel="Master Agreement § 12.1"
        showText={false}
        iconSize={16}
    />
);

export const WithoutACitationLabel: Story = () => (
    <CiteButton quoteText={QUOTE} quoteLabel="" />
);
