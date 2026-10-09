"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import {
  DropdownButton,
  DropdownSurface,
} from "@/shared/ui/dropdown";
import { OptionPill } from "@/app/components/ui/option-pill";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
  getOpenCodeGoModels,
  getBedrockModels,
  getCustomEndpointModels,
  getXaiModels,
  getOpenRouterModels,
  getVercelModels,
  type ApiKeySettings,
  type RouterCatalogModel,
} from "@/app/lib/mikeApi";
import {
  routerSelections,
  type RouterSlug,
} from "@/shared/lib/modelCatalog";
import {
  type AccountModelProvider,
  isSafeAccountModelId,
} from "@/app/lib/accountModelIds";
import { SettingsDescription } from "./SettingsText";

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

function modelCostLabel(model: RouterCatalogModel): string | null {
  if (!model.pricing) return null;
  const input = formatPerMillion(model.pricing.input);
  const output = formatPerMillion(model.pricing.output);
  const costs = [
    input ? `${input}/M input` : null,
    output ? `${output}/M output` : null,
  ].filter(Boolean);
  if (costs.length === 0) return null;
  if (model.pricing.tiered) costs.push("tiered pricing");
  if (model.pricing.variesByProvider) costs.push("varies by provider");
  return costs.join(" · ");
}

const CATALOG_MODEL_ID_RE = /^[^\s/]+\/[^\s]+$/;

/** Account-specific ids end up in a provider request path; see accountModelIds. */
const accountModelId =
  (provider: AccountModelProvider) => (id: string) =>
    isSafeAccountModelId(provider, id);

/**
 * A router's catalog-id rule, and how the placeholder/error text names it.
 * OpenRouter and Vercel publish vendor/model pairs; OpenCode Go publishes
 * bare model names, so requiring a slash there would reject its catalog.
 * Mirrors the backend's ROUTER_MODEL_ID_RE in routes/user.ts and, for
 * account-specific providers, isSafeAccountModelId in lib/llm/models.ts.
 */
const ROUTER_MODEL_ID: Record<
  RouterSlug,
  { accepts: (id: string) => boolean; shape: string; example: string; hint?: string }
> = {
  openrouter: {
    accepts: (id) => CATALOG_MODEL_ID_RE.test(id),
    shape: "vendor/model",
    example: "anthropic/claude-sonnet-5",
  },
  vercel: {
    accepts: (id) => CATALOG_MODEL_ID_RE.test(id),
    shape: "vendor/model",
    example: "anthropic/claude-sonnet-5",
  },
  "opencode-go": {
    accepts: (id) => /^[^\s]+$/.test(id),
    shape: "a model name with no spaces",
    example: "glm-5",
  },
  bedrock: {
    accepts: accountModelId("bedrock"),
    shape: "a Bedrock model or inference-profile ID with no spaces",
    example: "us.anthropic.claude-opus-5-5",
  },
  azure: {
    accepts: accountModelId("azure"),
    shape: "a deployment name with no spaces",
    example: "gpt-6.1-sol",
  },
  "azure-foundry": {
    accepts: accountModelId("azure-foundry"),
    shape: "a deployment name with no spaces",
    example: "claude-opus-5-5",
    hint: "Claude deployments are recognised by name. If a deployment is named differently, add it as anthropic:<name>, or openai:<name> for any other model.",
  },
  vertex: {
    accepts: accountModelId("vertex"),
    shape: "a Vertex AI model ID with no spaces",
    example: "gemini-3.1-pro-preview",
    hint: "Claude and publisher/model IDs are recognised by name. For other partner models add openai:<id>; anthropic:<id> and gemini:<id> also work.",
  },
  xai: {
    accepts: accountModelId("xai"),
    shape: "a model name with no spaces",
    example: "grok-4.3",
  },
  custom: {
    accepts: accountModelId("custom"),
    shape: "a model name with no spaces",
    example: "my-model",
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
  const { accepts } = ROUTER_MODEL_ID[provider];
  const stripped = raw.replace(new RegExp(`^${provider}/`), "");
  return accepts(stripped) ? stripped : raw;
}

/** Canonical form of a hand-typed model id, or null when it is not usable. */
export function normalizeTypedModelId(
  input: string,
  provider: RouterSlug,
): string | null {
  const model = typedModelCandidate(input, provider);
  if (model.length > MAX_MODEL_ID_LENGTH) return null;
  return ROUTER_MODEL_ID[provider].accepts(model) ? model : null;
}

function catalogModelMatches(model: RouterCatalogModel, query: string) {
  return (
    !query ||
    model.id.toLowerCase().includes(query) ||
    model.label.toLowerCase().includes(query)
  );
}

/**
 * Each router's Model Selections field: its label, its catalog loader
 * (omitted where ids are typed only), and the saved setting the catalog
 * depends on, so the field remounts and reloads when that setting changes.
 */
const ROUTER_SETTINGS: readonly {
  provider: RouterSlug;
  label: string;
  loadCatalog?: () => Promise<RouterCatalogModel[]>;
  catalogScope?: (settings: ApiKeySettings | undefined) => string | undefined;
}[] = [
  { provider: "openrouter", label: "OpenRouter", loadCatalog: getOpenRouterModels },
  { provider: "vercel", label: "Vercel AI Gateway", loadCatalog: getVercelModels },
  { provider: "opencode-go", label: "OpenCode Go", loadCatalog: getOpenCodeGoModels },
  {
    provider: "bedrock",
    label: "Amazon Bedrock",
    loadCatalog: getBedrockModels,
    catalogScope: (settings) => settings?.bedrock?.region,
  },
  { provider: "azure", label: "Azure OpenAI" },
  { provider: "azure-foundry", label: "Azure AI Foundry" },
  { provider: "vertex", label: "Google Vertex AI" },
  { provider: "xai", label: "xAI", loadCatalog: getXaiModels },
  {
    provider: "custom",
    label: "OpenAI-compatible endpoint",
    loadCatalog: getCustomEndpointModels,
    catalogScope: (settings) => settings?.custom?.baseUrl,
  },
];

export function RouterSettingsSection({ provider }: { provider?: RouterSlug } = {}) {
  const { profile, updateRouterModels } = useUserProfile();
  const visible = ROUTER_SETTINGS.filter(
    (router) =>
      (!provider || provider === router.provider) &&
      profile?.apiKeys[router.provider]?.configured === true,
  );
  if (!profile || visible.length === 0) return null;
  const selections = routerSelections(profile);

  return (
    <section id="routers" className="scroll-mt-6 space-y-3">
      <FieldLabel as="p">Model Selections</FieldLabel>
      <SettingsDescription>
        Add the models you want to use. Saved models appear in model selectors.
      </SettingsDescription>
      <div className="space-y-4">
        {visible.map((router) => (
          <RouterModelsSetting
            key={`${router.provider}:${router.catalogScope?.(profile.apiKeySettings) ?? ""}`}
            provider={router.provider}
            label={router.label}
            selection={selections[router.provider]}
            loadCatalog={router.loadCatalog}
            onSave={(models) => updateRouterModels(router.provider, models)}
          />
        ))}
      </div>
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
  /** Omitted for providers with no listable catalog: IDs are typed only. */
  loadCatalog?: () => Promise<RouterCatalogModel[]>;
  onSave: (models: string[]) => Promise<boolean>;
}) {
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
    if (!loadCatalog) return;
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
            `${label}'s model list could not be loaded. You can still type a model ID.`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [label, loadCatalog]);

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
        // Claim the Escape so the enclosing dialog (ModalUI listens on
        // window, after this) leaves itself open when focus is on the
        // chevron or elsewhere in the dialog rather than the input.
        event.preventDefault();
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
    if (!ok) setError(`${label} model preferences could not be saved.`);
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
          ? `Model IDs are at most ${MAX_MODEL_ID_LENGTH} characters.`
          : `"${candidate}" is not a model ID — pick one from the list, or type it as ${ROUTER_MODEL_ID[provider].shape}.`,
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
    <div className="min-w-0 space-y-3">
      {saving && (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
      )}
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
        <div className="relative min-w-0">
          <FormTextInput
            id={`${provider}-model-input`}
            ref={inputRef}
            type="text"
            aria-label={`${label} models`}
            // Without a catalog there is no list to control: a plain textbox.
            {...(loadCatalog
              ? {
                  role: "combobox",
                  "aria-autocomplete": "list" as const,
                  "aria-controls": catalogId,
                  "aria-expanded": catalogOpen,
                  "aria-activedescendant":
                    catalogOpen && activeCatalogIndex >= 0
                      ? `${catalogId}-option-${activeCatalogIndex}`
                      : undefined,
                }
              : {})}
            value={input}
            disabled={saving}
            placeholder={`e.g. ${ROUTER_MODEL_ID[provider].example}`}
            className={loadCatalog ? "pr-9" : undefined}
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
              // Escape closes an open catalog only; with it closed, the
              // key falls through and closes the enclosing modal.
              if (event.key === "Escape" && catalogOpen) {
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
          {loadCatalog && (
            <button
              type="button"
              disabled={saving || catalog.length === 0}
              aria-label={`Choose ${label} model`}
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
              className="absolute inset-y-0 right-3 flex items-center text-gray-400 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-default disabled:opacity-40"
            >
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform duration-200 ${catalogOpen ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </div>
        {/* In normal flow below the field, not an absolute overlay: the
            provider modal's body is a scroll container, which cut off an
            upward list and would hide a downward one below its edge.
            In flow, the modal grows (and scrolls) to show it. */}
        {catalogOpen && (
          <DropdownSurface
            data-testid={`${provider}-model-catalog`}
            className="mt-1.5 max-h-72 w-full overflow-y-auto p-1.5"
          >
            {/* Outside the listbox below: ARIA allows a listbox
                            only option/group children, and a stray div makes
                            the option indices a screen reader announces
                            disagree with aria-activedescendant. */}
            {typedModelId && (
              <div className="px-3 py-2 text-xs text-gray-400">
                Press Enter to add this model ID.
              </div>
            )}
            <div
              id={catalogId}
              role="listbox"
              aria-multiselectable="true"
              aria-label={`${label} model catalog`}
            >
              {visibleCatalog.map((model, index) => {
                const selected = selection.includes(model.id);
                const active = index === activeCatalogIndex;
                const costLabel = modelCostLabel(model);
                return (
                  <DropdownButton
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
                  </DropdownButton>
                );
              })}
            </div>
            {visibleCatalog.length === 0 && (
              <div className="px-3 py-2 text-xs text-gray-400">
                No matching models.
              </div>
            )}
          </DropdownSurface>
        )}
      </div>
      {selection.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selection.map((model) => (
            <OptionPill
              key={model}
              surface="flat"
              disabled={saving}
              aria-label={`Remove ${model}`}
              title={`Remove ${model}`}
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
      {ROUTER_MODEL_ID[provider].hint && (
        <p className="text-xs text-gray-500">
          {ROUTER_MODEL_ID[provider].hint}
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
