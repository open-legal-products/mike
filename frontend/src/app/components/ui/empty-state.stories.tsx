import type { Story } from "@ladle/react";
import { FileText, TriangleAlert } from "lucide-react";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButton } from "@/app/components/ui/pill-button";

const meta = { title: "UI / EmptyState" };
export default meta;

/**
 * The standard "nothing here yet" block. It also owns the display heading
 * style — there is no separate heading component.
 */
export const Default: Story = () => (
    <EmptyState
        icon={<FileText />}
        title="No documents yet"
        description="Upload a document or start from a template to get going."
        action={<PillButton tone="black">Upload a document</PillButton>}
    />
);

export const TitleOnly: Story = () => <EmptyState title="No results" />;

export const ErrorTone: Story = () => (
    <EmptyState
        icon={<TriangleAlert />}
        title="Couldn't load documents"
        description="Something went wrong on our side. Try again in a moment."
        tone="error"
        action={<PillButton tone="white">Retry</PillButton>}
    />
);
