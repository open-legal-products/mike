import { useEffect } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { clearToasts, showToast, ToastViewportUI } from "@/shared/ui/ToastUI";

const meta = { title: "Shared UI / Toast" };
export default meta;

export const Notifications = () => {
    useEffect(() => () => clearToasts(), []);
    return (
        <div className="flex flex-wrap gap-2">
            <PillButtonUI tone="black" onClick={() => showToast({
                tone: "error",
                title: "Couldn't save your changes",
                message: "Mike couldn't reach the server. Check your connection and try again.",
                actions: [{ label: "Retry", onClick: () => { showToast({ tone: "success", message: "Changes saved" }); } }],
                supportHref: "mailto:will@mikeoss.com",
            })}>Show error</PillButtonUI>
            <PillButtonUI tone="white" onClick={() => showToast({ tone: "success", message: "Changes saved" })}>Show success</PillButtonUI>
            <PillButtonUI tone="white" onClick={() => showToast({ tone: "info", message: "Your export is ready" })}>Show information</PillButtonUI>
            <ToastViewportUI />
        </div>
    );
};
