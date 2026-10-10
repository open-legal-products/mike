import { NoticeCardUI, noticeActionClassName } from "@/shared/ui/NoticeCardUI";

const meta = { title: "Shared UI / Notice card" };
export default meta;

/** The card both toasts and WarningPopup render. */
export const Tones = () => (
    <div className="flex w-[460px] flex-col gap-3">
        <NoticeCardUI
            tone="error"
            title="Couldn't save your changes"
            message="Mike couldn't reach the server. Check your connection and try again."
            onDismiss={() => {}}
            actions={
                <button type="button" className={noticeActionClassName()}>
                    Retry
                </button>
            }
        />
        <NoticeCardUI tone="success" message="Changes saved" onDismiss={() => {}} />
        <NoticeCardUI tone="info" message="Your export is ready" onDismiss={() => {}} />
    </div>
);
