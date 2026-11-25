"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { SettingsOverview } from "@/app/components/settings/SettingsOverview";

/** Settings' starting page: every section offered, as cards. */
export default function SettingsOverviewPage() {
    const router = useRouter();
    // A confirmed email change comes back to /settings?emailChange=processed
    // (as do links already sent in email); Account reports it.
    useEffect(() => {
        const search = window.location.search;
        if (new URLSearchParams(search).has("emailChange")) {
            router.replace(`/settings/account${search}`);
        }
    }, [router]);
    return <SettingsOverview />;
}
