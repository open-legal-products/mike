"use client";

import { Globe } from "lucide-react";
import { useRouter } from "next/navigation";
import { PillButton } from "@/app/components/ui/pill-button";

interface SsoAuthButtonProps {
    disabled?: boolean;
}

export function SsoAuthButton({ disabled = false }: SsoAuthButtonProps) {
    const router = useRouter();

    return (
        <PillButton
            type="button"
            tone="white"
            size="normal"
            className="w-full"
            disabled={disabled}
            onClick={() => router.push("/login/sso")}
        >
            <Globe aria-hidden="true" className="h-4 w-4" />
            Continue with SSO
        </PillButton>
    );
}
