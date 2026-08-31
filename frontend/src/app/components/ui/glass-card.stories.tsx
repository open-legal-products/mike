import type { Story } from "@ladle/react";
import { GlassCard } from "@/app/components/ui/glass-card";
import { PillButton } from "@/app/components/ui/pill-button";

const meta = { title: "UI / GlassCard" };
export default meta;

/**
 * The flat-tier card surface used by signup/login/onboarding. It takes children
 * only — the surface itself is the whole API.
 */
export const Default: Story = () => (
    <div className="max-w-sm">
        <GlassCard>
            <p className="font-serif text-2xl font-medium text-gray-900">
                Welcome back
            </p>
            <p className="mt-1 text-xs text-gray-400">
                Sign in to pick up where you left off.
            </p>
            <div className="mt-4">
                <PillButton tone="black">Continue</PillButton>
            </div>
        </GlassCard>
    </div>
);
