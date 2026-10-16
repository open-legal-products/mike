"use client";

import Link from "next/link";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";
import { CrashScreen } from "@/app/components/shared/CrashScreen";

export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset?: () => void;
}) {
    return (
        <CrashScreen
            error={error}
            reset={reset}
            component="route-error-boundary"
            secondaryAction={(tone) => (
                <Link
                    href="/"
                    className={pillButtonUIClassName({ tone, size: "normal" })}
                >
                    Home
                </Link>
            )}
        />
    );
}
