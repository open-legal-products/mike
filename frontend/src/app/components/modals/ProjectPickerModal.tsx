"use client";

import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { CheckSquare } from "@/app/components/ui/check-square";
import { SearchBar } from "@/app/components/ui/search-bar";
import { ClosedProjectSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import type { Project } from "../shared/types";
import { Modal } from "./Modal";
import {
    LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
    LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS,
} from "@/app/components/ui/liquid-surface";

type PrimaryAction = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className"
> & {
    label: ReactNode;
};

interface Props {
    open: boolean;
    onClose: () => void;
    projects: Project[];
    loading: boolean;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    breadcrumbs?: ReactNode[];
    primaryAction?: PrimaryAction;
}

export function ProjectPickerModal({
    open,
    onClose,
    projects,
    loading,
    selectedId,
    onSelect,
    breadcrumbs,
    primaryAction,
}: Props) {
    const [search, setSearch] = useState("");
    const q = search.toLowerCase().trim();
    const filtered = q
        ? projects.filter((p) => p.name.toLowerCase().includes(q))
        : projects;

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={breadcrumbs}
            primaryAction={primaryAction}
        >
            <div className="pt-1 pb-2">
                <SearchBar
                    value={search}
                    onValueChange={setSearch}
                    placeholder="Search projects..."
                    autoFocus
                />
            </div>
            <div data-modal-scroll="vertical" className="min-h-0 flex-1 overflow-y-auto pb-2">
                {loading ? (
                    <div className="space-y-px">
                        <div className="flex items-center rounded-md px-2 py-2">
                            <div className="h-3 w-14 rounded bg-gray-100 animate-pulse" />
                        </div>
                        {[65, 45, 80, 55, 70].map((w, i) => (
                            <div
                                key={i}
                                className="flex items-center gap-2 rounded-md px-2 py-2"
                            >
                                <div className="h-3.5 w-3.5 rounded border border-gray-200 shrink-0" />
                                <div className="h-3.5 w-3.5 rounded bg-gray-100 animate-pulse shrink-0" />
                                <div
                                    className="h-3 rounded bg-gray-100 animate-pulse"
                                    style={{ width: `${w}%` }}
                                />
                            </div>
                        ))}
                    </div>
                ) : filtered.length === 0 ? (
                    <p className="text-center text-sm text-gray-400 py-8">
                        {q ? "No matches found" : "No projects yet"}
                    </p>
                ) : (
                    <div className="rounded-sm overflow-hidden">
                        <div className="flex items-center justify-between px-2 py-2">
                            <p className="text-xs font-medium text-gray-400">
                                Projects
                            </p>
                        </div>
                        <div className="space-y-px">
                            {filtered.map((project) => {
                                const isSelected = selectedId === project.id;
                                const documentCount =
                                    project.document_count ??
                                    project.documents?.length ??
                                    0;
                                return (
                                    <button
                                        key={project.id}
                                        onClick={() =>
                                            onSelect(
                                                isSelected ? null : project.id,
                                            )
                                        }
                                        className={`w-full flex rounded-md items-center gap-2 px-2 py-2 text-xs transition-all text-left ${isSelected ? LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS : LIQUID_GLASS_MODAL_ROW_HOVER_CLASS}`}
                                    >
                                        <CheckSquare
                                            state={
                                                isSelected
                                                    ? "checked"
                                                    : "unchecked"
                                            }
                                        />
                                        <ClosedProjectSvgIcon className="h-3.5 w-3.5 shrink-0" />
                                        <span
                                            className={`flex-1 truncate ${isSelected ? "text-gray-900" : "text-gray-700"}`}
                                        >
                                            {project.name}
                                            {project.cm_number && (
                                                <span className="ml-1 font-normal text-gray-400">
                                                    (#{project.cm_number})
                                                </span>
                                            )}
                                        </span>
                                        <span className="shrink-0 text-gray-400">
                                            {documentCount}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
}
