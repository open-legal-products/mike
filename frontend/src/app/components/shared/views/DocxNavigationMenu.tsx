"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Ellipsis, ListTree } from "lucide-react";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import {
    Dropdown,
    DropdownButton,
    DropdownCheckboxItem,
    DropdownContent,
    DropdownTrigger,
} from "@/shared/ui/dropdown";

/** Extend EigenPal's overflow panel; keep navigation available when nothing overflows. */
export function DocxNavigationMenu({ toolbar, open, onToggle }: {
    toolbar: HTMLElement;
    open: boolean;
    onToggle: () => void;
}) {
    const [menu, setMenu] = useState<{ trigger: HTMLButtonElement | null; panel: HTMLElement | null }>({ trigger: null, panel: null });
    useEffect(() => {
        // The packaged toolbar has no overflow-content slot and mounts its
        // panel only while open. Follow native menu mounts and responsive changes.
        const sync = () => {
            const trigger = toolbar.querySelector<HTMLButtonElement>('[data-slot="toolbar.more"]');
            const panel = toolbar.querySelector<HTMLElement>(".docx-toolbar__more-panel");
            setMenu((previous) => previous.trigger === trigger && previous.panel === panel
                ? previous : { trigger, panel });
        };
        const observer = new MutationObserver(sync);
        observer.observe(toolbar, { childList: true, subtree: true });
        sync();
        return () => observer.disconnect();
    }, [toolbar]);

    if (menu.trigger) return menu.panel && createPortal(
        <DropdownButton
            className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5"
            aria-pressed={open}
            onClick={() => {
                onToggle();
                menu.trigger?.click();
                menu.trigger?.focus({ preventScroll: true });
            }}
        >
            <ListTree aria-hidden="true" className="h-4 w-4" />
            Navigation pane
            {open && <Check aria-hidden="true" className="ml-auto h-4 w-4" />}
        </DropdownButton>,
        menu.panel,
    );

    return createPortal(
        <span data-toolbar-fixed="" className="ml-auto flex flex-none items-center">
            <Dropdown>
                <DropdownTrigger asChild>
                    <TextButtonUI size="icon-xs" aria-label="More" title="More" className="h-6">
                        <Ellipsis aria-hidden="true" className="h-4 w-4" />
                    </TextButtonUI>
                </DropdownTrigger>
                <DropdownContent align="end">
                    <DropdownCheckboxItem checked={open} onCheckedChange={onToggle}>
                        <ListTree aria-hidden="true" className="h-4 w-4" />
                        Navigation pane
                    </DropdownCheckboxItem>
                </DropdownContent>
            </Dropdown>
        </span>,
        toolbar,
    );
}
