import {
  CANADA_PROVINCE_OPTIONS,
  COUNTRY_OPTIONS,
  US_STATE_OPTIONS,
} from "@/app/onboarding/options";

export type PlaybookListOption = {
  value: string;
  label: string;
  /** Shown indented under the option before it, such as a state. */
  nested?: boolean;
};

// The legal systems of the United Kingdom, which a contract chooses between.
const UK_JURISDICTION_OPTIONS = [
  "England and Wales",
  "Scotland",
  "Northern Ireland",
] as const;

const SUBDIVISIONS: Record<string, { names: readonly string[]; tag: string }> = {
  "United Kingdom": { names: UK_JURISDICTION_OPTIONS, tag: "UK" },
  "United States": { names: US_STATE_OPTIONS, tag: "US" },
  Canada: { names: CANADA_PROVINCE_OPTIONS, tag: "Canada" },
};

const countries = new Set<string>(COUNTRY_OPTIONS);

/**
 * Countries, each followed by its states, provinces, or legal systems. A
 * subdivision sharing a country's name (Georgia) is stored with its country.
 */
export const PLAYBOOK_JURISDICTION_OPTIONS: PlaybookListOption[] =
  COUNTRY_OPTIONS.flatMap((country) => [
    { value: country, label: country },
    ...(SUBDIVISIONS[country]?.names ?? []).map((name) => ({
      value: countries.has(name)
        ? `${name} (${SUBDIVISIONS[country].tag})`
        : name,
      label: name,
      nested: true,
    })),
  ]);
