import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import type { AssistantEvent } from "../../shared/types";
import { EventBlock } from "./EventBlocks";
import { EventDisclosureButton } from "./EventDisclosure";

type PythonRunEvent = Extract<AssistantEvent, { type: "python_run" }>;

function CopyCodeButton({ code }: { code: string }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 1500);
        return () => window.clearTimeout(timer);
    }, [copied]);
    return (
        <TextButtonUI
            size="icon-xs"
            aria-label="Copy code"
            title="Copy code"
            onClick={() => {
                navigator.clipboard
                    .writeText(code)
                    .then(() => setCopied(true))
                    .catch(() => {});
            }}
        >
            {copied ? (
                <Check aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            )}
        </TextButtonUI>
    );
}

export function PythonRunBlock({
    event,
    showConnector,
}: {
    event: PythonRunEvent;
    showConnector?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const failed = event.status === "failed";
    const label = event.isStreaming
        ? "Running code"
        : failed
          ? "Code failed"
          : "Ran code";
    const documents = event.documents ?? [];
    const files = event.files ?? [];

    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={event.isStreaming}
            dotColor={failed ? "red" : "green"}
        >
            <EventDisclosureButton
                open={open}
                onToggle={() => setOpen((value) => !value)}
                label={label}
                detail={
                    event.description ? (
                        <span className="[overflow-wrap:anywhere]">
                            {event.description}
                        </span>
                    ) : undefined
                }
                isStreaming={event.isStreaming}
            />
            {open && (
                <div className="mt-2 flex flex-col gap-3 text-xs">
                    <div>
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-gray-400">Code</p>
                            <CopyCodeButton code={event.code} />
                        </div>
                        <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-app-surface-active p-3 font-mono text-gray-800">
                            {event.code}
                        </pre>
                    </div>
                    {event.stdout ? (
                        <div>
                            <p className="text-gray-400">Output</p>
                            <pre className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md bg-app-surface-active p-3 font-mono text-gray-800">
                                {event.stdout}
                            </pre>
                        </div>
                    ) : null}
                    {event.error ? (
                        <p className="text-red-600 [overflow-wrap:anywhere]">
                            {event.error}
                        </p>
                    ) : null}
                    {documents.length > 0 && (
                        <p className="text-gray-600 [overflow-wrap:anywhere]">
                            Read {documents.map((item) => item.filename).join(", ")}
                        </p>
                    )}
                    {files.length > 0 && (
                        <p className="text-gray-600 [overflow-wrap:anywhere]">
                            Saved {files.map((item) => item.filename).join(", ")}
                        </p>
                    )}
                </div>
            )}
        </EventBlock>
    );
}
