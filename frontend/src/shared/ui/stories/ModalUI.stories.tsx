import { useState } from "react";
import { ModalUI } from "@/shared/ui/ModalUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const meta = { title: "Shared UI / Modal" };
export default meta;

export const Interactive = () => {
    const [open, setOpen] = useState(false);

    return (
        <>
            <PillButtonUI tone="black" onClick={() => setOpen(true)}>
                Open modal
            </PillButtonUI>
            <ModalUI
                open={open}
                onClose={() => setOpen(false)}
                breadcrumbs={["Documents", "Add document"]}
                ariaLabel="Add document"
                size="md"
                className="h-80"
                footerStatus={<span className="text-xs text-gray-400">Optional</span>}
                cancelAction={
                    <PillButtonUI tone="white" onClick={() => setOpen(false)}>
                        Cancel
                    </PillButtonUI>
                }
                primaryAction={
                    <PillButtonUI tone="blue" onClick={() => setOpen(false)}>
                        Add
                    </PillButtonUI>
                }
            >
                <div className="flex flex-1 flex-col justify-center py-6 text-center">
                    <h2 className="font-serif text-xl text-gray-900">Choose a document</h2>
                    <p className="mt-2 text-sm text-gray-500">
                        This example also demonstrates focus trapping, Escape, and
                        backdrop dismissal.
                    </p>
                </div>
            </ModalUI>
        </>
    );
};
