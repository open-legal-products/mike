import { CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Citation, DocumentCitationQuote } from "../../shared/types";
import { PillButton } from "../../ui/pill-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../ui/popover";

export type CitationVerificationDisplayState = "verified" | "unverified";

type VerificationPresentation = {
  label: string;
  description: string;
  pillClassName: string;
};

export type CitationsTranslator = ReturnType<typeof useTranslations>;

const UNVERIFIED_PRESENTATION: VerificationPresentation = {
  label: "Could not verify quote",
  description: "Quote could not be matched to the source text.",
  pillClassName:
    "!bg-red-100/85 !text-red-800 hover:!bg-red-200/80 hover:!text-red-800 dark:!bg-red-950 dark:!text-white dark:hover:!bg-red-900 dark:hover:!text-white",
};

export function citationVerificationState(
  citation: Citation,
): CitationVerificationDisplayState {
  return citation.verified === false ? "unverified" : "verified";
}

export function quoteVerificationState(
  quote: Pick<DocumentCitationQuote, "verification">,
): CitationVerificationDisplayState {
  return quote.verification?.verified === false ? "unverified" : "verified";
}

export function citationVerificationPillClassName(citation: Citation): string {
  return citationVerificationState(citation) === "unverified"
    ? UNVERIFIED_PRESENTATION.pillClassName
    : "";
}

export function citationVerificationDescription(
  citation: Citation,
  t?: CitationsTranslator,
): string | null {
  const state = citationVerificationState(citation);
  if (state !== "unverified") return null;
  return t ? t("naoVerificadaDescricao") : UNVERIFIED_PRESENTATION.description;
}

export function citationVerificationAriaLabel(
  citation: Citation,
  t?: CitationsTranslator,
): string {
  const state = citationVerificationState(citation);
  const label = t
    ? t("citacao", { ref: citation.ref })
    : `Citation ${citation.ref}`;
  const suffix =
    state === "unverified"
      ? `. ${t ? t("naoVerificada") : UNVERIFIED_PRESENTATION.label}`
      : "";
  return `${label}${suffix}`;
}

export function CitationVerificationBadge({
  state,
}: {
  state: CitationVerificationDisplayState;
}) {
  const t = useTranslations("assistant.citacoes");
  if (state !== "unverified") return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <PillButton
          tone="white"
          size="xs"
          className="w-fit gap-1 font-sans !text-red-600 hover:!text-red-700"
        >
          <CircleAlert className="h-3 w-3" aria-hidden="true" />
          {t("naoVerificada")}
        </PillButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="z-[220] w-72"
      >
        <span className="block text-xs font-medium text-gray-900">
          {t("citacaoNaoEncontrada")}
        </span>
        <span className="mt-1 block text-xs font-normal leading-5 text-gray-600">
          {t("citacaoNaoEncontradaDescricao")}
        </span>
      </PopoverContent>
    </Popover>
  );
}
