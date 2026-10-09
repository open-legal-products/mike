import type { ReactNode } from "react";
import { SiteLogo } from "@/app/components/site-logo";
import { authGlassCardUIClassName } from "@/shared/ui/AuthStylesUI";

export function OnboardingShell({
    step,
    title,
    description,
    children,
}: {
    step: string;
    title: string;
    description: string;
    children: ReactNode;
}) {
    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-24">
            <div className="absolute top-4 left-1/2 -translate-x-1/2 md:top-8">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={authGlassCardUIClassName}>
                    <p className="mb-2 text-xs font-medium text-gray-400">
                        {step}
                    </p>
                    <h1 className="font-serif text-2xl font-medium text-gray-950">
                        {title}
                    </h1>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                        {description}
                    </p>
                    <div className="mt-6">{children}</div>
                </div>
            </div>
        </div>
    );
}
