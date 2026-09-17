import { GlassCardUI } from "@/shared/ui/GlassCardUI";

const meta = { title: "Shared UI / GlassCard" };
export default meta;

export const Default = () => (
    <div className="w-full max-w-80">
        <GlassCardUI>
            <div className="p-4">
                <h3 className="font-serif text-lg text-gray-900">Matter summary</h3>
                <p className="mt-1 text-sm text-gray-500">
                    A shared surface that renders consistently in the web app and
                    Word add-in.
                </p>
            </div>
        </GlassCardUI>
    </div>
);
