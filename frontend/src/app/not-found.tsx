import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PillButton } from "@/app/components/ui/pill-button";

export default async function NotFound() {
    const t = await getTranslations("shell.errosGlobais");

    return (
        <div className="min-h-screen bg-white flex items-center justify-center px-4">
            <div className="text-center max-w-md">
                <h1 className="text-3xl font-eb-garamond font-light text-gray-900 mb-3">
                    {t("paginaNaoEncontrada")}
                </h1>
                <p className="text-[0.9375rem] text-gray-500 leading-relaxed mb-8">
                    {t("descricaoNaoEncontrada")}
                </p>

                <PillButton asChild tone="black" size="normal">
                    <Link href="/">{t("voltarInicio")}</Link>
                </PillButton>
            </div>
        </div>
    );
}
