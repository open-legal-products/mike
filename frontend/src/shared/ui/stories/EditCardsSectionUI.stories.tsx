import { EditCardUI } from "@/shared/ui/EditCardUI";
import { EditCardsSectionUI } from "@/shared/ui/EditCardsSectionUI";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const meta = { title: "Shared UI / EditCardsSection" };
export default meta;

export const GroupedChanges = () => (
    <div className="w-full max-w-[32rem]">
        <GlassCardUI>
            <EditCardsSectionUI
                summary="3 proposed changes"
                actions={
                    <>
                        <PillButtonUI tone="blue">Accept all</PillButtonUI>
                        <PillButtonUI tone="white">Reject all</PillButtonUI>
                    </>
                }
            >
                <EditCardUI
                    changeNumber={1}
                    replacementText="thirty days"
                    originalText="fourteen days"
                />
                <EditCardUI
                    changeNumber={2}
                    replacementText="Singapore"
                    originalText="England and Wales"
                />
                <EditCardUI
                    changeNumber={3}
                    replacementText="written consent"
                    originalText="consent"
                />
            </EditCardsSectionUI>
        </GlassCardUI>
    </div>
);

export const InitiallyCollapsed = () => (
    <div className="w-full max-w-[32rem]">
        <GlassCardUI>
            <EditCardsSectionUI summary="2 completed changes" defaultOpen={false}>
                <EditCardUI replacementText="First change" />
                <EditCardUI replacementText="Second change" />
            </EditCardsSectionUI>
        </GlassCardUI>
    </div>
);
