"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Brain, Trash2 } from "lucide-react";
import { SettingsSection } from "@/app/(pages)/settings/SettingsSection";
import { SettingsToggle } from "@/app/(pages)/settings/SettingsToggle";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { PillButton } from "@/app/components/ui/pill-button";
import {
    getUserMemory,
    setUserMemoryEnabled,
    wipeUserMemory,
    type MemoryCurrent,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

type ConfirmAction = "disable" | "wipe";

function memoryStatus(memory: MemoryCurrent) {
    if (!memory.enabled) return "Off";
    if (memory.status === "scheduled") return "On · review scheduled";
    if (memory.status === "processing") return "On · updating";
    if (memory.status === "failed") return "On · latest review failed";
    return "On";
}

export function MemorySettingsSection() {
    const [memory, setMemory] = useState<MemoryCurrent | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [mutation, setMutation] = useState<
        "enable" | "disable" | "wipe" | null
    >(null);
    const [confirmAction, setConfirmAction] =
        useState<ConfirmAction | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        try {
            const current = await getUserMemory(signal);
            if (signal?.aborted) return;
            setMemory(current);
            setLoadError(false);
        } catch {
            if (signal?.aborted) return;
            setLoadError(true);
        } finally {
            if (!signal?.aborted) setLoading(false);
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);

    async function enableMemory() {
        if (mutation) return;
        setMutation("enable");
        setError(null);
        try {
            setMemory(await setUserMemoryEnabled(true));
        } catch (cause) {
            setError(
                userFacingApiError(
                    cause,
                    "App-wide memory could not be turned on. Please try again.",
                ),
            );
        } finally {
            setMutation(null);
        }
    }

    async function confirmMutation() {
        if (!confirmAction || mutation) return;
        const action = confirmAction;
        setMutation(action);
        setError(null);
        try {
            const current =
                action === "disable"
                    ? await setUserMemoryEnabled(false)
                    : await wipeUserMemory();
            setMemory(current);
            setConfirmAction(null);
        } catch (cause) {
            setError(
                userFacingApiError(
                    cause,
                    action === "disable"
                        ? "App-wide memory could not be turned off. Please try again."
                        : "App-wide memory could not be wiped. Please try again.",
                ),
            );
            setConfirmAction(null);
        } finally {
            setMutation(null);
        }
    }

    const confirmIsDisable = confirmAction === "disable";

    return (
        <section
            id="memory"
            className="scroll-mt-4 space-y-3"
            aria-labelledby="memory-settings-heading"
        >
            <div className="flex items-center gap-2">
                <Brain aria-hidden="true" className="h-5 w-5 text-gray-500" />
                <h2
                    id="memory-settings-heading"
                    className="font-serif text-2xl font-medium text-gray-900"
                >
                    Memory
                </h2>
            </div>
            <SettingsSection>
                {loading ? (
                    <div
                        className="flex items-center justify-between gap-3 px-4 py-5"
                        aria-label="Loading memory settings"
                    >
                        <div className="space-y-2">
                            <div className="h-4 w-36 animate-pulse rounded bg-gray-200" />
                            <div className="h-3 w-72 max-w-full animate-pulse rounded bg-gray-100" />
                        </div>
                        <div className="h-5 w-9 animate-pulse rounded-full bg-gray-200" />
                    </div>
                ) : loadError || !memory ? (
                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-700">
                                Memory settings are unavailable
                            </p>
                            <p className="text-sm text-red-600" role="alert">
                                Could not load memory settings. Please try again.
                            </p>
                        </div>
                        <PillButton
                            tone="white"
                            size="sm"
                            onClick={() => void load()}
                        >
                            Retry
                        </PillButton>
                    </div>
                ) : (
                    <>
                        <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-gray-700">
                                    App-wide memory
                                </p>
                                <p className="max-w-xl text-sm text-gray-500">
                                    Let Mike curate useful details after saved
                                    conversations and use them in future answers.
                                </p>
                            </div>
                            <div className="flex items-center gap-3">
                                <span
                                    className="text-xs font-medium text-gray-500"
                                    role="status"
                                    aria-live="polite"
                                >
                                    {memoryStatus(memory)}
                                </span>
                                <SettingsToggle
                                    checked={memory.enabled}
                                    loading={mutation === "enable"}
                                    disabled={mutation !== null}
                                    size="md"
                                    ariaLabel="App-wide memory"
                                    onChange={(enabled) => {
                                        if (enabled) void enableMemory();
                                        else setConfirmAction("disable");
                                    }}
                                />
                            </div>
                        </div>

                        <div className="flex flex-col gap-3 border-t border-gray-100 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-gray-700">
                                    Review memory
                                </p>
                                <p className="max-w-xl text-sm text-gray-500">
                                    Inspect, edit, download, or restore versions of
                                    the Markdown file.
                                </p>
                            </div>
                            <PillButton asChild tone="white" size="sm">
                                <Link href="/memory">View memory</Link>
                            </PillButton>
                        </div>

                        <div className="flex flex-col gap-3 border-t border-gray-100 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-gray-700">
                                    Wipe memory
                                </p>
                                <p className="max-w-xl text-sm text-gray-500">
                                    Delete the file and its history while keeping
                                    memory turned on for future conversations.
                                </p>
                            </div>
                            <PillButton
                                tone="danger"
                                size="sm"
                                disabled={
                                    mutation !== null ||
                                    (memory.hash === null &&
                                        memory.status === "idle")
                                }
                                onClick={() => setConfirmAction("wipe")}
                            >
                                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                                Wipe memory
                            </PillButton>
                        </div>

                        {error ? (
                            <p
                                className="border-t border-gray-100 px-4 py-3 text-sm text-red-600"
                                role="alert"
                            >
                                {error}
                            </p>
                        ) : null}
                    </>
                )}
            </SettingsSection>

            <ConfirmPopup
                open={confirmAction !== null}
                title={
                    confirmIsDisable
                        ? "Turn off and delete app-wide memory?"
                        : "Wipe app-wide memory?"
                }
                message={
                    confirmIsDisable
                        ? "This permanently deletes memory.md and its version history and cancels pending memory updates. Memory will remain off until you turn it on again. This cannot be undone."
                        : "This permanently deletes memory.md and its version history and cancels pending memory updates. Memory stays on and can be rebuilt from future conversations. This cannot be undone."
                }
                confirmLabel={
                    confirmIsDisable ? "Disable" : "Wipe memory"
                }
                confirmVariant="danger"
                confirmStatus={mutation ? "loading" : "idle"}
                onConfirm={() => void confirmMutation()}
                onCancel={() => {
                    if (!mutation) setConfirmAction(null);
                }}
            />
        </section>
    );
}
