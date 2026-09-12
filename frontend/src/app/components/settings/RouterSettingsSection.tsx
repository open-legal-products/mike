"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import {
  LiquidDropdownButton,
  LiquidDropdownSurface,
} from "@/app/components/ui/liquid-dropdown";
import { OptionPill } from "@/app/components/ui/option-pill";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
  getOpenCodeGoModels,
  getOpenRouterModels,
  getVercelModels,
  type RouterCatalogModel,
} from "@/app/lib/mikeApi";
import type { RouterSlug } from "@/app/components/assistant/ModelToggle";
import { SettingsCard } from "./SettingsCard";
import { SettingsHeading } from "./SettingsHeading";
import { SettingsRow } from "./SettingsRow";
import { SettingsDescription, SettingsLabel } from "./SettingsText";

const COST_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

function formatPerMillion(value?: string): string | null {
  if (value === undefined) return null;
  const amount = Number(value) * 1_000_000;
  return Number.isFinite(amount) && amount >= 0
    ? COST_FORMATTER.format(amount)
    : null;
}

type RouterCostTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

function modelCostLabel(
  model: RouterCatalogModel,
  t: RouterCostTranslator,
): string | null {
  if (!model.pricing) return null;
  const input = formatPerMillion(model.pricing.input);
  const output = formatPerMillion(model.pricing.output);
  const costs = [
    input ? t("custoEntrada", { custo: input }) : null,
    output ? t("custoSaida", { custo: output }) : null,
  ].filter(Boolean);
  if (costs.length === 0) return null;
  if (model.pricing.tiered) costs.push(t("precoEscalonado"));
  if (model.pricing.variesByProvider) costs.push(t("precoVaria"));
  return costs.join(" · ");
}

const CATALOG_MODEL_ID_RE = /^[^\s/]+\/[^\s]+$/;

/**
 * A router's catalog-id shape, and how the placeholder/error text names it.
 * OpenRouter and Vercel publish vendor/model pairs; OpenCode Go publishes
 * bare model names, so requiring a slash there would reject its catalog.
 * Mirrors the backend's ROUTER_MODEL_ID_RE in routes/user.ts.
 */
const ROUTER_MODEL_ID: Record<
  RouterSlug,
  { pattern: RegExp; shapeKey: string; example: string }
> = {
  openrouter: {
    pattern: CATALOG_MODEL_ID_RE,
    shapeKey: "formatoVendedorModelo",
    example: "anthropic/claude-sonnet-5",
  },
  vercel: {
    pattern: CATALOG_MODEL_ID_RE,
    shapeKey: "formatoVendedorModelo",
    example: "anthropic/claude-sonnet-5",
  },
  "opencode-go": {
    pattern: /^[^\s]+$/,
    shapeKey: "formatoNomeModelo",
    example: "glm-5",
  },
};

/**
 * user_router_models CHECKs `char_length(model_id) between 1 and 200`, so a
 * longer id is a guaranteed 400 from the profile PATCH. Enforcing it here
 * turns that round trip into an immediate, specific message.
 */
export const MAX_MODEL_ID_LENGTH = 200;

/**
 * The id a typed string would become, before it is validated. The router slug
 * is stripped only when the remainder is still a full vendor/model id: some
 * catalog ids legitimately start with the router's own slug (OpenRouter's
 * "openrouter/auto", Vercel's "vercel/v0-1.5-md") and must be kept verbatim —
 * mirrors the backend's normalizeRouterModels.
 */
function typedModelCandidate(input: string, provider: RouterSlug): string {
  const raw = input.trim();
  const { pattern } = ROUTER_MODEL_ID[provider];
  const stripped = raw.replace(new RegExp(`^${provider}/`), "");
  return pattern.test(stripped) ? stripped : raw;
}

/** Canonical form of a hand-typed model id, or null when it is not usable. */
export function normalizeTypedModelId(
  input: string,
  provider: RouterSlug,
): string | null {
  const model = typedModelCandidate(input, provider);
  if (model.length > MAX_MODEL_ID_LENGTH) return null;
  return ROUTER_MODEL_ID[provider].pattern.test(model) ? model : null;
}

function catalogModelMatches(model: RouterCatalogModel, query: string) {
  return (
    !query ||
    model.id.toLowerCase().includes(query) ||
    model.label.toLowerCase().includes(query)
  );
}

export function RouterSettingsSection() {
  const t = useTranslations("configuracoes.roteadores");
  const {
    profile,
    updateOpenRouterModels,
    updateVercelModels,
    updateOpenCodeGoModels,
  } = useUserProfile();
  const openRouterConfigured = profile?.apiKeys.openrouter.configured === true;
  const vercelConfigured = profile?.apiKeys.vercel.configured === true;
  const openCodeGoConfigured =
    profile?.apiKeys["opencode-go"].configured === true;

  if (!openRouterConfigured && !vercelConfigured && !openCodeGoConfigured) {
    return null;
  }

  return (
    <section id="routers" className="scroll-mt-6 space-y-3">
      <SettingsHeading>{t("titulo")}</SettingsHeading>
      <SettingsDescription>
        {t("descricao")}
      </SettingsDescription>
      <SettingsCard>
        {openRouterConfigured && (
          <RouterModelsSetting
            provider="openrouter"
            label="OpenRouter"
            selection={profile?.openRouterModels ?? []}
            loadCatalog={getOpenRouterModels}
            onSave={updateOpenRouterModels}
          />
        )}
        {vercelConfigured && (
          <RouterModelsSetting
            provider="vercel"
            label="Vercel AI Gateway"
            selection={profile?.vercelModels ?? []}
            loadCatalog={getVercelModels}
            onSave={updateVercelModels}
          />
        )}
        {openCodeGoConfigured && (
          <RouterModelsSetting
            provider="opencode-go"
            label="OpenCode Go"
            selection={profile?.openCodeGoModels ?? []}
            loadCatalog={getOpenCodeGoModels}
            onSave={updateOpenCodeGoModels}
          />
        )}
      </SettingsCard>
    </section>
  );
}

function RouterModelsSetting({
  provider,
  label,
  selection,
  loadCatalog,
  onSave,
}: {
  provider: RouterSlug;
  label: string;
  selection: string[];
  loadCatalog: () => Promise<RouterCatalogModel[]>;
  onSave: (models: string[]) => Promise<boolean>;
}) {
  const t = useTranslations("configuracoes.roteadores");
  const [catalog, setCatalog] = useState<RouterCatalogModel[]>([]);
  const [input, setInput] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [activeCatalogIndex, setActiveCatalogIndex] = useState(-1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typeaheadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const catalogId = `${provider}-model-catalog`;

  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then((models) => {
        if (!cancelled) {
          setCatalog(models);
          setError(null);
          if (inputRef.current?.value.trim()) {
            setCatalogOpen(true);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog([]);
          setError(
            t("erroCarregarCatalogo", { label }),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [label, loadCatalog, t]);

  useEffect(() => {
    if (!catalogOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !typeaheadRef.current?.contains(event.target)
      ) {
        setCatalogOpen(false);
        setActiveCatalogIndex(-1);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCatalogOpen(false);
        setActiveCatalogIndex(-1);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [catalogOpen]);

  const save = async (next: string[]) => {
    setSaving(true);
    setError(null);
    const ok = await onSave(next);
    setSaving(false);
    if (!ok) setError(t("erroSalvarPreferencias", { label }));
  };

  // Enter with no explicit highlight adds exactly what the user typed — and
  // never a lookalike. When the text is not usable as an id, Enter explains
  // why: a keypress that does nothing and says nothing reads as a broken
  // control, and the user has no way to learn what shape is expected.
  const add = () => {
    const candidate = typedModelCandidate(input, provider);
    // An empty box is the one silent case — nothing was asked for.
    if (!candidate) return;
    const model = normalizeTypedModelId(input, provider);
    if (!model) {
      setError(
        candidate.length > MAX_MODEL_ID_LENGTH
          ? t("erroIdLongo", { count: MAX_MODEL_ID_LENGTH })
          : t("erroIdInvalido", {
              candidate,
              shape: t(ROUTER_MODEL_ID[provider].shapeKey),
            }),
      );
      return;
    }
    setError(null);
    setInput("");
    setCatalogOpen(false);
    setActiveCatalogIndex(-1);
    if (!selection.includes(model)) void save([...selection, model]);
  };

  const visibleCatalog = catalog.filter((model) => {
    const query = input.trim().toLowerCase();
    return catalogModelMatches(model, query);
  });
  const typedModelId = normalizeTypedModelId(input, provider);

  const selectCatalogModel = (model: string) => {
    setInput("");
    setCatalogOpen(false);
    setActiveCatalogIndex(-1);
    if (!selection.includes(model)) void save([...selection, model]);
  };

  const moveCatalogHighlight = (direction: 1 | -1) => {
    if (visibleCatalog.length === 0) return;
    setCatalogOpen(true);
    setActiveCatalogIndex((current) => {
      if (current < 0) {
        return direction === 1 ? 0 : visibleCatalog.length - 1;
      }
      return (
        (current + direction + visibleCatalog.length) % visibleCatalog.length
      );
    });
  };

  return (
    <SettingsRow layout="stacked">
      <div className="flex items-center gap-2">
        <div>
          <SettingsLabel>{t("modelosDoRouter", { label })}</SettingsLabel>
        </div>
        {saving && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
        )}
      </div>
      <div
        ref={typeaheadRef}
        className="relative"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setCatalogOpen(false);
            setActiveCatalogIndex(-1);
          }
        }}
      >
        {catalogOpen && (
          <LiquidDropdownSurface
            data-testid={`${provider}-model-catalog`}
            className="absolute bottom-full left-0 z-50 mb-1.5 max-h-72 w-full overflow-y-auto p-1.5"
          >
            {/* Outside the listbox below: ARIA allows a listbox
                            only option/group children, and a stray div makes
                            the option indices a screen reader announces
                            disagree with aria-activedescendant. */}
            {typedModelId && (
              <div className="px-3 py-2 text-xs text-gray-400">
                {t("pressioneEnter")}
              </div>
            )}
            <div
              id={catalogId}
              role="listbox"
              aria-multiselectable="true"
              aria-label={t("catalogoModelos", { label })}
            >
              {visibleCatalog.map((model, index) => {
                const selected = selection.includes(model.id);
                const active = index === activeCatalogIndex;
                const costLabel = modelCostLabel(model, t);
                return (
                  <LiquidDropdownButton
                    key={model.id}
                    id={`${catalogId}-option-${index}`}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveCatalogIndex(index)}
                    onClick={() => selectCatalogModel(model.id)}
                    className={`flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left ${active ? "bg-app-surface-hover text-gray-800" : ""}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-gray-700">
                        {model.label}
                      </span>
                      {model.label !== model.id && (
                        <span className="block truncate text-[10px] text-gray-400">
                          {model.id}
                        </span>
                      )}
                      {costLabel && (
                        <span className="block truncate text-[10px] text-gray-400">
                          {costLabel}
                        </span>
                      )}
                    </span>
                    {selected && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                    )}
                  </LiquidDropdownButton>
                );
              })}
            </div>
            {visibleCatalog.length === 0 && (
              <div className="px-3 py-2 text-xs text-gray-400">
                {t("nenhumModelo")}
              </div>
            )}
          </LiquidDropdownSurface>
        )}
        <div
          className={`flex h-9 min-w-0 flex-1 items-center px-0 focus-within:border-gray-200 focus-within:ring-2 focus-within:ring-gray-300/45 ${SETTINGS_CONTROL_CLASS}`}
        >
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label={t("modelosDoRouter", { label })}
            aria-autocomplete="list"
            aria-controls={catalogId}
            aria-expanded={catalogOpen}
            aria-activedescendant={
              catalogOpen && activeCatalogIndex >= 0
                ? `${catalogId}-option-${activeCatalogIndex}`
                : undefined
            }
            value={input}
            disabled={saving}
            placeholder={t("placeholderExemplo", {
              exemplo: ROUTER_MODEL_ID[provider].example,
            })}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 disabled:cursor-not-allowed"
            onChange={(event) => {
              setInput(event.target.value);
              // Typing never claims a highlight: Enter must add
              // the typed id verbatim unless the user points at
              // a row (arrow keys or hover). A default top-row
              // highlight made Enter after typing a full valid
              // id add a substring-matching catalog row instead.
              setActiveCatalogIndex(-1);
              if (catalog.length > 0) setCatalogOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveCatalogHighlight(1);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                moveCatalogHighlight(-1);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setCatalogOpen(false);
                setActiveCatalogIndex(-1);
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const highlighted =
                  catalogOpen && activeCatalogIndex >= 0
                    ? visibleCatalog[activeCatalogIndex]
                    : undefined;
                if (highlighted) {
                  selectCatalogModel(highlighted.id);
                  return;
                }
                add();
              }
            }}
          />
          <button
            type="button"
            disabled={saving || catalog.length === 0}
            aria-label={t("escolherModelo", { label })}
            aria-controls={catalogId}
            aria-expanded={catalogOpen}
            aria-haspopup="listbox"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const nextOpen = !catalogOpen;
              setCatalogOpen(nextOpen);
              // Highlight only ever follows an explicit arrow
              // key or pointer hover — opening the list doesn't
              // pre-claim a row for Enter.
              setActiveCatalogIndex(-1);
              if (nextOpen) inputRef.current?.focus();
            }}
            className="flex h-full shrink-0 items-center justify-end text-gray-400 transition-colors hover:text-gray-700 disabled:cursor-default disabled:opacity-40"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform duration-200 ${catalogOpen ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      </div>
      {selection.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selection.map((model) => (
            <OptionPill
              key={model}
              disabled={saving}
              aria-label={t("removerModelo", { modelo: model })}
              title={t("removerModelo", { modelo: model })}
              onClick={() =>
                void save(selection.filter((item) => item !== model))
              }
            >
              <span className="truncate">{model}</span>
              <X className="h-3 w-3 shrink-0 text-gray-400" />
            </OptionPill>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </SettingsRow>
  );
}
