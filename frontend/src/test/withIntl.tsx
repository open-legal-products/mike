import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import ptBR from "../../messages/pt-BR.json";

export type WithIntlMessages = {
    [key: string]: string | WithIntlMessages;
};

function mergeMessages(
    base: WithIntlMessages,
    override: WithIntlMessages,
): WithIntlMessages {
    const merged: WithIntlMessages = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const current = merged[key];
        if (
            value && typeof value === "object" &&
            current && typeof current === "object"
        ) {
            merged[key] = mergeMessages(
                current as WithIntlMessages,
                value as WithIntlMessages,
            );
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

export function withIntl(
    ui: ReactElement,
    messages: WithIntlMessages = {},
) {
    return (
        <NextIntlClientProvider
            locale="pt-BR"
            messages={mergeMessages(ptBR, messages)}
        >
            {ui}
        </NextIntlClientProvider>
    );
}
