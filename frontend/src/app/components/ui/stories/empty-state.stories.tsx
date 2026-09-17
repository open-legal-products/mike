import { FileText, TriangleAlert } from "lucide-react";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const meta = { title: "UI / EmptyState" };
export default meta;

/**
 * The standard "nothing here yet" block. It also owns the display heading
 * style — there is no separate heading component.
 */
export const Default = () => (
    <EmptyState
        icon={<FileText />}
        title="No documents yet"
        description="Upload a document or start from a template to get going."
        action={<PillButtonUI tone="black">Upload a document</PillButtonUI>}
    />
);

export const TitleOnly = () => <EmptyState title="No results" />;

export const ErrorTone = () => (
    <EmptyState
        icon={<TriangleAlert />}
        title="Couldn't load documents"
        description="Something went wrong on our side. Try again in a moment."
        tone="error"
        action={<PillButtonUI tone="white">Retry</PillButtonUI>}
    />
);
