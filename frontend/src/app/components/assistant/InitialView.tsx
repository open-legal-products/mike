"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import Image from "next/image";
import { MoreHorizontal } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { MikeIcon } from "@/shared/ui/MikeIconUI";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import type { Document, Message, QuickAction } from "../shared/types";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/shared/ui/LiquidGlassUI";

interface InitialViewProps {
    onSubmit: (message: Message) => void;
    inputRef?: RefObject<ChatInputHandle | null>;
    onDocumentClick?: (document: Document) => void;
    quickActions: QuickAction[];
    onEditQuickActions: () => void;
}

const ICON_SIZE = 30;
const GAP = 12; // gap-4 = 1rem = 16px
export function InitialView({
    onSubmit,
    onDocumentClick,
    inputRef,
    quickActions,
    onEditQuickActions,
}: InitialViewProps) {
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const [loaded, setLoaded] = useState(false);
    const [iconOffset, setIconOffset] = useState(0);
    const [textOffset, setTextOffset] = useState(0);
    const textRef = useRef<HTMLHeadingElement>(null);
    const localInputRef = useRef<ChatInputHandle>(null);
    const chatInputRef = inputRef ?? localInputRef;

    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";
    const visibleQuickActions = quickActions.filter((action) => action.enabled);

    useLayoutEffect(() => {
        if (!profile || !textRef.current) return;
        const h1Width = textRef.current.offsetWidth;
        setIconOffset((h1Width + GAP) / 2);
        setTextOffset((ICON_SIZE + GAP) / 2);
    }, [profile]);

    useEffect(() => {
        if (!iconOffset) return;
        const t = setTimeout(() => setLoaded(true), 100);
        return () => clearTimeout(t);
    }, [iconOffset]);

    function handleQuickAction(action: QuickAction) {
        const workflow = action.workflow;
        if (action.document_upload) {
            // The template-drafting default should open the picker on the
            // Templates tab, as the pre-database quick action did. Title is
            // the only stable handle the quick-action row exposes today; if
            // the user renames their copy the picker falls back to Files.
            const wantsTemplates =
                workflow.title.trim().toLowerCase() === "draft from template";
            chatInputRef.current?.startWorkflowDocumentSelection(
                workflow,
                action.prompt,
                wantsTemplates
                    ? { initialDocumentTab: "templates" }
                    : undefined,
            );
        } else {
            chatInputRef.current?.startWorkflow(workflow, action.prompt);
        }
    }

    return (
        <div className="grid h-full w-full grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] px-6">
            <div className="flex min-h-0 items-end justify-center pb-6">
                <div className="relative h-10 w-full max-w-4xl px-0 xl:px-8">
                    <div
                        className="absolute h-[30px] w-[30px]"
                        style={{
                            left: "50%",
                            top: "50%",
                            transform: loaded
                                ? `translate(calc(-50% - ${iconOffset}px), -50%)`
                                : "translate(-50%, -50%)",
                            transition:
                                "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                        }}
                    >
                        <MikeIcon size={ICON_SIZE} />
                    </div>
                    <h1
                        ref={textRef}
                        className="absolute text-4xl font-serif font-light text-gray-900 whitespace-nowrap"
                        style={{
                            left: "50%",
                            top: "50%",
                            transform: loaded
                                ? `translate(calc(-50% + ${textOffset}px), -50%)`
                                : "translate(-50%, -50%)",
                            opacity: loaded ? 1 : 0,
                            transition:
                                "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 800ms ease-in-out 300ms",
                        }}
                    >
                        Hi, {username}
                    </h1>
                </div>
            </div>

            <div className="w-full max-w-4xl justify-self-center px-0 xl:px-8">
                <ChatInput
                    ref={chatInputRef}
                    onSubmit={onSubmit}
                    onDocumentClick={onDocumentClick}
                    onCancel={() => {}}
                    isLoading={false}
                />
            </div>

            <div className="min-h-0 w-full max-w-4xl justify-self-center px-0 pt-1 xl:px-8">
                <div className="text-center">
                    <p className="text-xs py-2 mb-12 text-gray-500">
                        AI can make mistakes. Answers are not legal advice.
                    </p>
                </div>

                {profile?.quickActionsVisible !== false && (
                    <div className="flex flex-col items-center">
                        <div className="group relative flex h-5 items-center justify-center">
                            <span className="flex items-center gap-1.5 text-xs font-medium text-gray-800">
                                <Image
                                    src="/icons/features/quick-actions.svg"
                                    alt=""
                                    width={14}
                                    height={14}
                                    unoptimized
                                    aria-hidden="true"
                                    className="h-3.5 w-3.5 shrink-0"
                                />
                                Quick actions
                            </span>
                            <button
                                type="button"
                                onClick={onEditQuickActions}
                                aria-label="Configure quick actions"
                                className="absolute left-full ml-1.5 flex h-5 w-5 items-center justify-center text-gray-400 opacity-0 transition-all hover:text-gray-700 group-hover:opacity-100 focus:opacity-100"
                            >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                        </div>
                        <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs">
                            {visibleQuickActions.map((action) => (
                                <button
                                    key={action.id}
                                    type="button"
                                    onClick={() => handleQuickAction(action)}
                                    className={`inline-flex h-8 items-center justify-center rounded-full px-3 font-medium text-gray-600 ${LIQUID_GLASS_SUBTLE_CLASS} ${LIQUID_GLASS_HOVER_CLASS} transition-all hover:text-gray-900 active:scale-[0.98] disabled:cursor-default disabled:opacity-45 disabled:active:scale-100`}
                                >
                                    {action.name?.trim() ||
                                        action.workflow.title}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
