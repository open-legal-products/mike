"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { settingsTabButtonClassName } from "./settingsStyles";

interface TabDef {
    id: string;
    labelKey: string;
    href: string;
}

const TABS: TabDef[] = [
    {
        id: "account",
        labelKey: "configuracoes.layout.tabConta",
        href: "/settings",
    },
    {
        id: "personalisation",
        labelKey: "configuracoes.layout.tabPersonalizacao",
        href: "/settings/personalisation",
    },
    {
        id: "memory",
        labelKey: "configuracoes.layout.tabMemoria",
        href: "/settings/memory",
    },
    {
        id: "appearance",
        labelKey: "configuracoes.layout.tabAparencia",
        href: "/settings/appearance",
    },
    {
        id: "features",
        labelKey: "configuracoes.layout.tabRecursos",
        href: "/settings/features",
    },
    {
        id: "privacy-data",
        labelKey: "configuracoes.layout.tabPrivacidade",
        href: "/settings/privacy-data",
    },
    {
        id: "security",
        labelKey: "configuracoes.layout.tabSeguranca",
        href: "/settings/security",
    },
    {
        id: "models",
        labelKey: "pages.modelos.preferenciasTitulo",
        href: "/settings/models",
    },
    {
        id: "byok",
        labelKey: "configuracoes.layout.tabChavesProprias",
        href: "/settings/byok",
    },
    {
        id: "connectors",
        labelKey: "configuracoes.layout.tabConectores",
        href: "/settings/connectors",
    },
];

export default function SettingsLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const t = useTranslations();
    const router = useRouter();
    const pathname = usePathname();
    const { isAuthenticated, authLoading } = useAuth();

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/");
        }
    }, [isAuthenticated, authLoading, router]);

    if (authLoading) {
        return (
            <div className="h-dvh flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <header className="mx-auto flex h-16 w-full max-w-5xl shrink-0 items-end px-6 pb-2 md:h-24 md:pb-4">
                <h1 className="text-4xl font-medium font-eb-garamond">
                    {t("configuracoes.layout.titulo")}
                </h1>
            </header>

            <main className="mx-auto w-full max-w-5xl flex-1 px-6 pb-10 pt-4 md:pt-6">
                <div className="grid grid-cols-1 gap-y-6 md:grid-cols-[224px_minmax(0,1fr)] md:gap-x-10">
                    <nav
                        aria-label={t("configuracoes.layout.titulo")}
                        className="z-10 -ml-3 min-w-0 self-start md:sticky md:top-4"
                    >
                        <div className="-m-1 min-w-0 p-1">
                            <div className="-m-1 min-w-0 overflow-x-auto overflow-y-hidden p-1">
                                <ul className="mb-0 flex gap-1 md:flex-col">
                                    {TABS.map((tab) => {
                                        const active =
                                            pathname === tab.href ||
                                            (tab.href !== "/settings" &&
                                                pathname.startsWith(tab.href));
                                        return (
                                            <li key={tab.id}>
                                                <button
                                                    type="button"
                                                    aria-current={
                                                        active
                                                            ? "page"
                                                            : undefined
                                                    }
                                                    onClick={() =>
                                                        router.push(tab.href)
                                                    }
                                                    className={settingsTabButtonClassName(
                                                        active,
                                                    )}
                                                >
                                                    {t(tab.labelKey)}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        </div>
                    </nav>

                    <div className="min-w-0 outline-none">{children}</div>
                </div>
            </main>
        </div>
    );
}
