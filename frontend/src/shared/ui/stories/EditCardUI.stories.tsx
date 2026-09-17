import { EditCardUI } from "@/shared/ui/EditCardUI";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";

const meta = { title: "Shared UI / EditCard" };
export default meta;

function Frame({ children }: { children: React.ReactNode }) {
    return (
        <div className="w-full max-w-[30rem]">
            <GlassCardUI>
                <div className="p-3">{children}</div>
            </GlassCardUI>
        </div>
    );
}

export const ProposedChange = () => (
    <Frame>
        <EditCardUI
            changeNumber={1}
            reason="Clarifies when either party may terminate the agreement."
            replacementText="Either party may terminate on thirty days’ written notice."
            originalText="Either party may terminate with notice."
            locationHint="Section 8.2 — Term and termination"
            onAccept={() => undefined}
            onReject={() => undefined}
            onView={() => undefined}
        />
    </Frame>
);

export const Applying = () => (
    <Frame>
        <EditCardUI
            reason="Updates the governing law."
            replacementText="This agreement is governed by Singapore law."
            originalText="This agreement is governed by English law."
            busyAction="apply"
            onApply={() => undefined}
        />
    </Frame>
);

export const Resolved = () => (
    <Frame>
        <EditCardUI
            status="accepted"
            statusMessage="Change accepted"
            statusMessageClassName="text-green-700"
            replacementText="The revised clause"
            originalText="The original clause"
            onAccept={() => undefined}
            onReject={() => undefined}
        />
    </Frame>
);
