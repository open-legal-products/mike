"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Image from "next/image";
import { Plus } from "lucide-react";
import { ConnectorSetupGuideLink } from "@/app/components/settings/ConnectorSetupGuideLink";
import { NewCustomMcpModal } from "@/app/components/settings/NewCustomMcpModal";
import { ConnectorCard } from "@/app/components/settings/ConnectorCard";
import {
  McpConnectorForm,
  type McpConnectorFormDraft,
} from "@/app/components/settings/McpConnectorForm";
import {
  CONNECTOR_PRESETS,
  findConnectorPreset,
  normalizedServerUrl,
} from "@/app/components/settings/connectorPresets";
import {
  ConnectorDetailsModal,
  type ConnectorDetailsView,
} from "@/app/components/settings/ConnectorDetailsModal";
import {
  GoogleAuthorizationCancelledError,
  GoogleConnectorFlowError,
  useGoogleConnector,
  type GoogleConnector,
  type GoogleConnectorProvider,
} from "@/app/components/settings/useGoogleConnector";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import {
  type McpConnectorSummary,
  MikeApiError,
  isConnectorSetupError,
  createMcpConnector,
  deleteMcpConnector,
  getMcpConnector,
  isMfaRequiredError,
  listMcpConnectors,
  refreshMcpConnectorTools,
  setMcpToolEnabled,
  startMcpConnectorOAuth,
  updateMcpConnector,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { LIQUID_GLASS_SUBTLE_CLASS } from "@/shared/ui/LiquidGlassUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";

type PendingMfaAction =
  | { type: "create"; draft: AddDraft; surface: CreateSurface }
  | { type: "google-add"; provider: GoogleConnectorProvider }
  // A Google settings change or delete; replayed as-is after verification.
  | { type: "google-update"; retry: () => Promise<void> }
  | { type: "write-approval"; connectorId: string; enabled: boolean }
  | { type: "read-only"; connectorId: string; enabled: boolean }
  | { type: "save"; connectorId: string }
  | { type: "clear-token"; connectorId: string }
  | { type: "delete"; connectorId: string }
  | { type: "refresh"; connectorId: string }
  | { type: "connector-enabled"; connectorId: string; enabled: boolean }
  | {
      type: "tool-enabled";
      connectorId: string;
      toolId: string;
      enabled: boolean;
    };

type AddDraft = McpConnectorFormDraft;
type DetailDraft = McpConnectorFormDraft;

type AddStep = "form" | "working" | "auth" | "success";
type CreateSurface = "modal" | "page";

/**
 * How long the details modal waits after the last keystroke before committing
 * an edit. Long enough that typing a URL or a token is one request, not one
 * per character.
 */
const AUTOSAVE_DELAY_MS = 1200;

const CONNECTOR_SETUP_GUIDE_URL =
  "https://github.com/open-legal-products/mike/blob/main/docs/connectors.md";

const emptyAddDraft: AddDraft = {
  name: "",
  serverUrl: "",
  bearerToken: "",
  customHeaders: "",
};

type McpOAuthPopupMessage = {
  type?: string;
  success?: boolean;
  connectorId?: string;
  detail?: string;
};

/**
 * Thrown to unwind the OAuth wait when the user cancels the flow or navigates
 * away (the component unmounts) rather than because authorization genuinely
 * failed. Callers use it to distinguish "abandoned on purpose" — which should
 * quietly reset the UI — from a real error worth surfacing to the user.
 */
class McpOAuthCancelledError extends Error {
  constructor(message = "OAuth authorization was cancelled.") {
    super(message);
    this.name = "McpOAuthCancelledError";
  }
}

function parseCustomHeaders(raw: string): Record<string, string> | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Custom headers must be a JSON object.");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error("Custom header values must be strings.");
    }
    headers[key] = value;
  }
  return headers;
}

function isGoogleMcpConnector(connector: McpConnectorSummary) {
  try {
    const hostname = new URL(connector.serverUrl).hostname.toLowerCase();
    return (
      hostname === "googleapis.com" || hostname.endsWith(".googleapis.com")
    );
  } catch {
    return false;
  }
}

function connectorSetupGuideUrl(serverUrl: string) {
  try {
    const hostname = new URL(serverUrl).hostname.toLowerCase();
    if (hostname === "slack.com" || hostname.endsWith(".slack.com")) {
      return `${CONNECTOR_SETUP_GUIDE_URL}#slack`;
    }
    if (hostname === "googleapis.com" || hostname.endsWith(".googleapis.com")) {
      return `${CONNECTOR_SETUP_GUIDE_URL}#google-hosted-mcp-servers`;
    }
  } catch {
    // A setup-required response is only produced for a parsed, known provider
    // URL, but retain a useful general guide if that invariant ever changes.
  }
  return CONNECTOR_SETUP_GUIDE_URL;
}

const CONNECTOR_PLACEHOLDER_COLORS = [
  "bg-violet-400",
  "bg-sky-400",
  "bg-emerald-400",
  "bg-amber-400",
  "bg-rose-400",
] as const;

const CONNECTOR_PLACEHOLDER_SHAPES = [
  "h-5 w-5 rounded-full",
  "h-5 w-5 rounded-md",
  "h-4 w-6 rounded-full",
  "h-4 w-4 rotate-45 rounded",
] as const;

function connectorPlaceholderClassName(connector: McpConnectorSummary) {
  // Keep the random-looking mark stable across reloads and connector edits.
  const hash = Array.from(connector.id).reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  const color = CONNECTOR_PLACEHOLDER_COLORS[
    hash % CONNECTOR_PLACEHOLDER_COLORS.length
  ];
  const shape = CONNECTOR_PLACEHOLDER_SHAPES[
    Math.floor(hash / CONNECTOR_PLACEHOLDER_COLORS.length) %
      CONNECTOR_PLACEHOLDER_SHAPES.length
  ];
  return `${color} ${shape}`;
}

function ConnectorBrandIcon({ name }: { name: string }) {
  if (name === "Slack") {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        <path
          fill="#E01E5A"
          d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
        />
        <path
          fill="#36C5F0"
          d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
        />
        <path
          fill="#2EB67D"
          d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"
        />
        <path
          fill="#ECB22E"
          d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
        />
      </svg>
    );
  }

  if (name === "Airtable") {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        <path
          fill="#FCB400"
          d="M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257z"
        />
        <path
          fill="#18BFFF"
          d="M23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596z"
        />
        <path
          fill="#F82B60"
          d="M.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z"
        />
      </svg>
    );
  }

  if (name === "Linear") {
    return (
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5 fill-[#5E6AD2]"
        aria-hidden="true"
      >
        <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
      </svg>
    );
  }

  if (name === "Lawve") {
    return (
      <svg viewBox="0 0 178 178" className="h-5 w-5" aria-hidden="true">
        <path fill="#EB523A" d="M89.5 92.9 3 42v68.1l86.5 50.9V92.9Z" />
        <path fill="#EB3A3A" d="M89.5 92.9 176 42v68.1l-86.5 50.9V92.9Z" />
        <path fill="#EB663A" d="M45.87 18 3 42.93l86.47 50.76 43.28-25.17L45.87 18Z" />
        <path fill="#EB663A" d="M133.13 18 176 42.93 89.53 93.69 46.25 68.52 133.13 18Z" />
        <ellipse fill="#EB3A3A" cx="89.5" cy="68.46" rx="19.22" ry="9.61" />
        <rect fill="#EB3A3A" x="70.28" y="54.04" width="38.44" height="14.42" />
        <ellipse fill="#EB6F3A" cx="89.5" cy="53.44" rx="19.22" ry="9.01" />
        <ellipse fill="#EB3A3A" cx="134.55" cy="42.63" rx="18.62" ry="9.01" />
        <rect fill="#EB3A3A" x="115.93" y="27.61" width="37.24" height="14.42" />
        <ellipse fill="#EB6F3A" cx="134.55" cy="27.61" rx="18.62" ry="9.61" />
        <ellipse fill="#EB3A3A" cx="46.25" cy="42.63" rx="19.22" ry="9.01" />
        <rect fill="#EB3A3A" x="27.03" y="27.61" width="38.44" height="15.62" />
        <ellipse fill="#EB6F3A" cx="46.25" cy="27.61" rx="19.22" ry="9.61" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-black dark:fill-white" aria-hidden="true">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
    </svg>
  );
}

function googleSetupGuideUrl(provider: GoogleConnectorProvider) {
  return `https://github.com/open-legal-products/mike/blob/main/docs/${
    provider === "google-drive" ? "google-drive" : "google-workspace"
  }.md`;
}

function GoogleConnectorIcon({
  provider,
}: {
  provider: GoogleConnectorProvider;
}) {
  return (
    <Image
      src={`/icons/integrations/${provider}.png`}
      alt=""
      aria-hidden="true"
      width={20}
      height={20}
      unoptimized
      className="h-5 w-5 object-contain"
    />
  );
}

function googleDetailsView(
  connector: GoogleConnector,
): ConnectorDetailsView | null {
  const status = connector.status;
  if (!status?.connected) return null;
  return {
    id: connector.provider,
    name: connector.name,
    tools: status.tools.map((tool) => ({
      id: tool.name,
      title: tool.title,
      description: tool.description,
      enabled: tool.enabled,
      write: tool.write,
    })),
    toolCount: status.tools.length,
    requireWriteApproval: status.requireWriteApproval,
    readOnly: status.readOnly === true,
    accountEmail: status.accountEmail,
  };
}

function mcpDetailsView(connector: McpConnectorSummary): ConnectorDetailsView {
  return {
    id: connector.id,
    name: connector.name,
    tools: connector.tools.map((tool) => ({
      id: tool.id,
      title: tool.title || tool.toolName,
      description: tool.description,
      enabled: tool.enabled,
      write: tool.write,
    })),
    toolCount: connector.toolCount,
    requireWriteApproval: connector.requireWriteApproval,
    readOnly: connector.readOnly === true,
  };
}

export default function ConnectorsPage() {
  const [connectors, setConnectors] = useState<McpConnectorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingMfaAction, setPendingMfaAction] =
    useState<PendingMfaAction | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddDraft>(emptyAddDraft);
  const [addStep, setAddStep] = useState<AddStep>("form");
  const [addResult, setAddResult] = useState<McpConnectorSummary | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [addErrorGuideUrl, setAddErrorGuideUrl] = useState<string | null>(null);
  const [addAuthMessage, setAddAuthMessage] = useState<string | null>(null);
  const [installingPresetUrl, setInstallingPresetUrl] = useState<string | null>(
    null,
  );
  const [authorizingPresetUrl, setAuthorizingPresetUrl] = useState<
    string | null
  >(null);
  const [showAddToken, setShowAddToken] = useState(false);
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(
    null,
  );
  const [selectedConnectorDetails, setSelectedConnectorDetails] =
    useState<McpConnectorSummary | null>(null);
  const [detailDraft, setDetailDraft] = useState<DetailDraft>({
    ...emptyAddDraft,
  });
  const [detailError, setDetailError] = useState<string | null>(null);
  // Setup steps from a Refresh on an unconfigured provider, shown inside
  // the details modal (a page-level banner would sit behind it).
  const [detailSetupNotice, setDetailSetupNotice] = useState<string | null>(
    null,
  );
  const [loadingConnectorId, setLoadingConnectorId] = useState<string | null>(
    null,
  );
  const [clearedBearerTokenConnectorId, setClearedBearerTokenConnectorId] =
    useState<string | null>(null);
  const [showDetailToken, setShowDetailToken] = useState(false);
  // Which connector currently has a reconnect OAuth wait in flight (the
  // details modal's Refresh flow). Drives the Cancel affordance next to the
  // Refresh button, mirroring the escape hatch the add modal already has.
  const [reconnectingConnectorId, setReconnectingConnectorId] = useState<
    string | null
  >(null);

  const selectedConnector = selectedConnectorDetails;
  const initializedDetailConnectorIdRef = useRef<string | null>(null);
  // Hooks in a fixed order: Discover lists Google in this order too.
  const googleDrive = useGoogleConnector("google-drive", "Google Drive");
  const gmail = useGoogleConnector("gmail", "Gmail");
  const googleCalendar = useGoogleConnector(
    "google-calendar",
    "Google Calendar",
  );
  const googleConnectors = [googleDrive, gmail, googleCalendar];
  const [selectedGoogleProvider, setSelectedGoogleProvider] =
    useState<GoogleConnectorProvider | null>(null);
  const selectedGoogle =
    googleConnectors.find(
      (connector) => connector.provider === selectedGoogleProvider,
    ) ?? null;

  const loadConnectors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConnectors(await listMcpConnectors());
    } catch (err) {
      setError(userFacingApiError(err, "Failed to load connectors."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnectors();
  }, [loadConnectors]);

  // Holds the AbortController for an in-flight OAuth completion wait. A single
  // flow can run at a time, so a ref (not state) is the right home: it is
  // read/written imperatively and must never trigger a re-render.
  const oauthAbortRef = useRef<AbortController | null>(null);

  // If the user navigates away (or this page unmounts for any reason) while an
  // OAuth popup wait is running, abort it. Without this the poll's setTimeout
  // chain keeps firing authenticated GETs for up to five minutes and calls
  // setState on an unmounted component. The empty dependency array makes the
  // returned function a true unmount cleanup.
  useEffect(() => {
    return () => {
      oauthAbortRef.current?.abort();
      oauthAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!selectedConnector) {
      initializedDetailConnectorIdRef.current = null;
      return;
    }
    if (initializedDetailConnectorIdRef.current === selectedConnector.id)
      return;
    initializedDetailConnectorIdRef.current = selectedConnector.id;
    setDetailDraft({
      name: selectedConnector.name,
      serverUrl: selectedConnector.serverUrl,
      bearerToken: "",
      customHeaders: "",
    });
    setDetailError(null);
    // detailSetupNotice is deliberately NOT reset here: the Add flow sets
    // it in the same batch that selects the new connector, and this
    // effect runs right after that render. It is cleared on open/close
    // and before every sensitive action instead.
    setClearedBearerTokenConnectorId(null);
    setShowDetailToken(false);
  }, [selectedConnector]);

  const replaceConnector = (
    connector: McpConnectorSummary,
    options: { preserveToolsOnEmpty?: boolean } = {},
  ) => {
    const mergeConnector = (current: McpConnectorSummary) => {
      if (
        options.preserveToolsOnEmpty &&
        connector.tools.length === 0 &&
        current.tools.length > 0
      ) {
        return { ...connector, tools: current.tools };
      }
      return connector;
    };
    setConnectors((prev) => {
      const exists = prev.some((item) => item.id === connector.id);
      if (!exists) return [connector, ...prev];
      return prev.map((item) =>
        item.id === connector.id ? mergeConnector(item) : item,
      );
    });
    setSelectedConnectorDetails((current) =>
      current?.id === connector.id ? mergeConnector(current) : current,
    );
  };

  const openConnectorDetails = async (connectorId: string) => {
    setSelectedConnectorId(connectorId);
    setSelectedConnectorDetails((current) =>
      current?.id === connectorId
        ? current
        : (connectors.find((connector) => connector.id === connectorId) ??
          null),
    );
    setDetailError(null);
    setDetailSetupNotice(null);
    setLoadingConnectorId(connectorId);
    try {
      const fresh = await getMcpConnector(connectorId);
      replaceConnector(fresh);
      // A connector created moments ago (the Add flow's setup-required
      // handover) is not in this closure's `connectors`, so the seed
      // above found nothing and replaceConnector only merges into an
      // existing selection. Adopt the fetched record unless the user
      // has since opened a different connector.
      setSelectedConnectorDetails((current) =>
        current && current.id !== connectorId ? current : fresh,
      );
    } catch (err) {
      setDetailError(
        userFacingApiError(err, "Failed to load connector details."),
      );
    } finally {
      setLoadingConnectorId((current) =>
        current === connectorId ? null : current,
      );
    }
  };

  const runSensitiveAction = async (
    action: PendingMfaAction,
    fn: () => Promise<void>,
  ) => {
    setError(null);
    setDetailError(null);
    setDetailSetupNotice(null);
    try {
      if (await needsMfaVerification()) {
        setPendingMfaAction(action);
        return;
      }
      await fn();
    } catch (err) {
      if (isMfaRequiredError(err)) {
        setPendingMfaAction(action);
        return;
      }
      if (
        isConnectorSetupError(err) &&
        action.type === "refresh" &&
        selectedConnectorId === action.connectorId
      ) {
        // Refresh from the details modal on a Slack/Google connector
        // whose OAuth client is not configured on this server: show
        // the operator guidance where the user is looking.
        setDetailSetupNotice(err.message);
        return;
      }
      const message = userFacingApiError(
        err,
        action.type === "google-add"
          ? "Failed to add connector."
          : "Action failed.",
      );
      if (action.type === "google-add") {
        setAddErrorGuideUrl(
          isConnectorSetupError(err)
            ? googleSetupGuideUrl(action.provider)
            : null,
        );
        setAddError(message);
      } else if (action.type === "create") {
        setAddErrorGuideUrl(
          isConnectorSetupError(err)
            ? connectorSetupGuideUrl(action.draft.serverUrl)
            : null,
        );
        setAddError(message);
      } else if (
        action.type === "save" ||
        action.type === "google-update" ||
        action.type === "write-approval" ||
        action.type === "read-only"
      )
        setDetailError(message);
      else setError(message);
    }
  };

  // Adding a Google connector behaves like adding Slack: setup problems and
  // failures appear in the same "Could not add connector" warning.
  const handleAddGoogle = async (provider: GoogleConnectorProvider) => {
    const connector = googleConnectors.find(
      (candidate) => candidate.provider === provider,
    );
    if (!connector) return;
    if (connector.loadFailed) {
      setAddErrorGuideUrl(null);
      setAddError(
        `Could not load ${connector.name}. Reload this page and try again.`,
      );
      return;
    }
    if (connector.status?.schemaReady === false) {
      setAddErrorGuideUrl(googleSetupGuideUrl(provider));
      setAddError(
        `An administrator needs to apply the ${
          provider === "google-drive" ? "Google Drive" : "Gmail and Calendar"
        } database migration and restart the server before you can add ${connector.name}.`,
      );
      return;
    }
    await runSensitiveAction({ type: "google-add", provider }, async () => {
      try {
        await connector.connect();
      } catch (err) {
        if (err instanceof GoogleAuthorizationCancelledError) return;
        if (err instanceof GoogleConnectorFlowError) {
          setAddErrorGuideUrl(null);
          setAddError(err.message);
          return;
        }
        throw err;
      }
    });
  };

  /** A Manage-dialog change to a Google connector, under the usual MFA gate. */
  const runGoogleUpdate = async (busy: string, change: () => Promise<void>) => {
    const run = async () => {
      setBusyKey(busy);
      try {
        await change();
      } finally {
        setBusyKey(null);
      }
    };
    await runSensitiveAction({ type: "google-update", retry: run }, run);
  };

  const handleDeleteGoogle = (connector: GoogleConnector) =>
    runGoogleUpdate(`delete:${connector.provider}`, async () => {
      await connector.disconnect();
      setSelectedGoogleProvider(null);
    });

  const closeAddModal = () => {
    // "working" is a brief synchronous create with nothing to cancel, so we
    // still block closing there. "auth" used to be blocked too, which trapped
    // the user for the full five-minute timeout whenever the popup closed
    // without a detectable result (COOP severs `popup.closed`, so we cannot
    // know). Closing during "auth" now aborts the pending OAuth wait via the
    // ref, giving the user a reliable escape hatch.
    if (addStep === "working") return;
    if (addStep === "auth") {
      oauthAbortRef.current?.abort();
      oauthAbortRef.current = null;
    }
    setAddOpen(false);
    setAddDraft(emptyAddDraft);
    setAddStep("form");
    setAddResult(null);
    setAddError(null);
    setAddErrorGuideUrl(null);
    setAddAuthMessage(null);
    setShowAddToken(false);
  };

  const connectConnectorOAuth = async (
    connectorId: string,
  ): Promise<McpConnectorSummary | null> => {
    const popup = window.open(
      "about:blank",
      "mike_mcp_oauth",
      "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
    );
    let started: Awaited<ReturnType<typeof startMcpConnectorOAuth>>;
    try {
      started = await startMcpConnectorOAuth(connectorId);
    } catch (err) {
      // The popup is opened *before* the start call so browsers treat it
      // as user-initiated. When the start call fails — typically the 400
      // "connector_setup_required" answer for a Slack/Google client the
      // deployment has not configured yet — nothing will ever navigate
      // that window, so close it instead of stranding an about:blank
      // popup next to the setup notice (seen live on 2026-09-06).
      popup?.close();
      throw err;
    }
    const { authorizationUrl, alreadyAuthorized, callbackOrigin } = started;
    if (alreadyAuthorized) {
      popup?.close();
      const refreshed = await refreshMcpConnectorTools(connectorId);
      replaceConnector(refreshed);
      return refreshed;
    }
    if (!authorizationUrl) {
      popup?.close();
      throw new Error("OAuth authorization URL was not returned.");
    }
    const expectedCallbackOrigin = new URL(callbackOrigin).origin;
    if (!popup) {
      window.location.assign(authorizationUrl);
      return null;
    }
    popup.location.href = authorizationUrl;

    // A single OAuth wait runs at a time. Register its AbortController so the
    // Cancel affordance and the unmount cleanup can tear it down; abort any
    // stray previous flow first.
    const abortController = new AbortController();
    oauthAbortRef.current?.abort();
    oauthAbortRef.current = abortController;
    const { signal } = abortController;

    // Wait for authorization to complete. Strict identity providers (Google
    // among them) serve their consent page with
    // `Cross-Origin-Opener-Policy: same-origin`, which severs `window.opener`
    // and makes `popup.closed` unreadable from here. That breaks both the
    // callback's `postMessage` and any `popup.closed` polling, and a blocked
    // `popup.closed` read can even report a false "closed". So we treat the
    // backend's `oauthConnected` flag as the source of truth and poll for it,
    // while still honouring a `postMessage` on the chance it gets through.
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          action();
        };
        const timeout = window.setTimeout(
          () =>
            finish(() => reject(new Error("OAuth authorization timed out."))),
          5 * 60 * 1000,
        );
        // Self-rescheduling poll rather than a fixed setInterval. Two reasons:
        // (1) we back the cadence off from 1.5s to 5s after the first minute
        // — the happy path resolves in seconds, so a user slowly reading a
        // consent screen shouldn't generate ~200 authenticated GETs over the
        // five-minute window; (2) chaining the next poll only after the
        // previous read settles guarantees we never stack requests on a slow
        // connection.
        const pollStarted = Date.now();
        let pollTimer = 0;
        const scheduleNextPoll = () => {
          const elapsed = Date.now() - pollStarted;
          const delay = elapsed < 60_000 ? 1500 : 5000;
          pollTimer = window.setTimeout(runPoll, delay);
        };
        const runPoll = () => {
          void getMcpConnector(connectorId)
            .then((connector) => {
              if (settled) return;
              if (connector.oauthConnected) {
                finish(resolve);
                return;
              }
              scheduleNextPoll();
            })
            .catch(() => {
              // Transient read errors shouldn't abort the wait.
              if (!settled) scheduleNextPoll();
            });
        };
        const onAbort = () =>
          finish(() => reject(new McpOAuthCancelledError()));
        const cleanup = () => {
          window.clearTimeout(timeout);
          window.clearTimeout(pollTimer);
          signal.removeEventListener("abort", onAbort);
          window.removeEventListener("message", onMessage);
        };
        const onMessage = (event: MessageEvent<McpOAuthPopupMessage>) => {
          if (event.origin !== expectedCallbackOrigin) return;
          if (event.data?.type !== "mcp_oauth_result") return;
          if (
            event.data.connectorId &&
            event.data.connectorId !== connectorId
          ) {
            return;
          }
          const sourceWindow = event.source as Window | null;
          sourceWindow?.postMessage(
            { type: "mcp_oauth_result_ack" },
            event.origin,
          );
          if (event.data.success) {
            finish(resolve);
            return;
          }
          finish(() =>
            reject(
              new Error(event.data.detail || "OAuth authorization failed."),
            ),
          );
        };
        window.addEventListener("message", onMessage);
        signal.addEventListener("abort", onAbort);
        // Everything (cleanup, onMessage, onAbort) is now defined, so it is
        // safe to both start polling and honour an abort that may already
        // have fired before we finished wiring up.
        scheduleNextPoll();
        if (signal.aborted) onAbort();
      });
    } finally {
      if (oauthAbortRef.current === abortController) {
        oauthAbortRef.current = null;
      }
      try {
        popup.close();
      } catch {
        // COOP may block closing a severed popup; it self-closes anyway.
      }
    }

    const refreshed = await refreshMcpConnectorTools(connectorId);
    replaceConnector(refreshed);
    return refreshed;
  };

  const handleCreate = async (
    draft: AddDraft = addDraft,
    surface: CreateSurface = "modal",
  ) => {
    await runSensitiveAction({ type: "create", draft, surface }, async () => {
      const authorizeConnector = async (connectorId: string) => {
        if (surface === "page") setAuthorizingPresetUrl(draft.serverUrl);
        try {
          return await connectConnectorOAuth(connectorId);
        } finally {
          if (surface === "page") setAuthorizingPresetUrl(null);
        }
      };

      setBusyKey("create");
      if (surface === "page") setInstallingPresetUrl(draft.serverUrl);
      if (surface === "modal") {
        setAddStep("working");
        setAddError(null);
      }
      setAddErrorGuideUrl(null);
      setAddAuthMessage(null);
      // Kept outside the try so every failed or cancelled registration can
      // remove the just-created row before surfacing the error.
      let createdConnector: McpConnectorSummary | null = null;
      const discardCreatedConnector = async () => {
        if (!createdConnector) return true;
        const connectorId = createdConnector.id;
        try {
          await deleteMcpConnector(connectorId);
          setConnectors((current) =>
            current.filter((connector) => connector.id !== connectorId),
          );
          createdConnector = null;
          return true;
        } catch {
          return false;
        }
      };
      try {
        const headers = parseCustomHeaders(draft.customHeaders);
        const created = await createMcpConnector({
          name: draft.name,
          serverUrl: draft.serverUrl,
          bearerToken: draft.bearerToken.trim() || null,
          ...(headers ? { headers } : {}),
        });
        const connector = created.connector;
        createdConnector = connector;
        replaceConnector(connector);
        const needsAuthorization =
          created.oauthRequired ||
          (!connector.oauthConnected &&
            (surface === "page" || isGoogleMcpConnector(connector)));
        if (needsAuthorization) {
          if (surface === "modal") {
            setAddAuthMessage(
              "Complete authorization in the popup to finish connecting this MCP server.",
            );
            setAddStep("auth");
          }
          const authorized = await authorizeConnector(connector.id);
          if (authorized && surface === "modal") {
            setAddAuthMessage(null);
            setAddResult(authorized);
            setAddStep("success");
          }
          return;
        }
        if (surface === "modal") {
          setAddResult(connector);
          setAddStep("success");
        }
      } catch (err) {
        // A user-initiated cancel (or navigation away) is not a failure:
        // closeAddModal has already reset the modal, so surfacing an
        // error would be noise. Just release the busy lock via `finally`.
        if (err instanceof McpOAuthCancelledError) {
          const discarded = await discardCreatedConnector();
          if (!discarded) {
            setAddError(
              "Authorization was cancelled, but the incomplete connector could not be removed. Remove it from Installed before trying again.",
            );
          }
          return;
        }
        if (surface === "modal") {
          setAddStep("form");
          setAddAuthMessage(null);
        }
        if (
          err instanceof MikeApiError &&
          err.code === "connector_cleanup_failed"
        ) {
          // Creation failed after the backend inserted the row and its own
          // cleanup also failed. Reload so the warning's instruction to remove
          // the incomplete connector from Installed is immediately actionable.
          await loadConnectors();
        }
        const message = userFacingApiError(err, "Failed to add connector.");
        const discarded = await discardCreatedConnector();
        setAddErrorGuideUrl(
          isConnectorSetupError(err)
            ? connectorSetupGuideUrl(draft.serverUrl)
            : null,
        );
        setAddError(
          discarded
            ? message
            : `${message} The incomplete connector could not be removed; remove it from Installed before trying again.`,
        );
      } finally {
        setBusyKey(null);
        if (surface === "page") setInstallingPresetUrl(null);
      }
    });
  };

  const handleSaveSelectedConnector = async () => {
    if (!selectedConnector) return;
    const submittedDraft = detailDraft;
    await runSensitiveAction(
      { type: "save", connectorId: selectedConnector.id },
      async () => {
        setBusyKey(`save:${selectedConnector.id}`);
        setDetailError(null);
        setDetailSetupNotice(null);
        try {
          const headers = parseCustomHeaders(submittedDraft.customHeaders);
          const saved = await updateMcpConnector(selectedConnector.id, {
            name: submittedDraft.name,
            serverUrl: submittedDraft.serverUrl,
            ...(submittedDraft.bearerToken.trim()
              ? { bearerToken: submittedDraft.bearerToken.trim() }
              : {}),
            ...(headers ? { headers } : {}),
          });
          const shouldRefreshTools =
            saved.serverUrl !== selectedConnector.serverUrl ||
            !!submittedDraft.bearerToken.trim() ||
            !!headers;
          const refreshed = shouldRefreshTools
            ? await refreshMcpConnectorTools(saved.id)
            : saved;
          replaceConnector(refreshed, {
            preserveToolsOnEmpty: !shouldRefreshTools,
          });
          setDetailDraft((current) =>
            current.name === submittedDraft.name &&
            current.serverUrl === submittedDraft.serverUrl &&
            current.bearerToken === submittedDraft.bearerToken &&
            current.customHeaders === submittedDraft.customHeaders
              ? {
                  name: refreshed.name,
                  serverUrl: refreshed.serverUrl,
                  bearerToken: "",
                  customHeaders: "",
                }
              : current,
          );
        } finally {
          setBusyKey(null);
        }
      },
    );
  };

  // The details modal has no Save button: a settled edit commits itself.
  // Held in a ref so the debounce effect below depends only on the draft and
  // the gates, not on this handler's identity.
  const saveSelectedConnectorRef = useRef(handleSaveSelectedConnector);
  saveSelectedConnectorRef.current = handleSaveSelectedConnector;
  // The exact draft each autosave was attempted for, so the same payload is
  // never sent twice. A failed save and a dismissed MFA prompt both leave the
  // draft dirty; without this, either could re-enter the debounce window on a
  // timer the user never asked for. Only a further edit re-arms it.
  const autosaveAttemptRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedConnector) return;
    // Never autosave over an in-flight request, and never let the timer be
    // what raises the MFA prompt again while one is already pending.
    if (busyKey || pendingMfaAction) return;
    const name = detailDraft.name.trim();
    const serverUrl = detailDraft.serverUrl.trim();
    // The same validity the Save button used to enforce.
    if (!name || !serverUrl) return;
    const dirty =
      name !== selectedConnector.name ||
      serverUrl !== selectedConnector.serverUrl ||
      detailDraft.bearerToken.trim().length > 0 ||
      detailDraft.customHeaders.trim().length > 0;
    if (!dirty) return;
    // Headers are edited as free-form JSON. A pause while the object is only
    // partially typed is not a failed save; wait until it parses before
    // starting the debounce timer.
    if (detailDraft.customHeaders.trim()) {
      try {
        parseCustomHeaders(detailDraft.customHeaders);
      } catch {
        return;
      }
    }
    const attempt = JSON.stringify([
      selectedConnector.id,
      name,
      serverUrl,
      detailDraft.bearerToken,
      detailDraft.customHeaders,
    ]);
    if (autosaveAttemptRef.current === attempt) return;
    const timer = setTimeout(() => {
      autosaveAttemptRef.current = attempt;
      void saveSelectedConnectorRef.current();
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [busyKey, detailDraft, pendingMfaAction, selectedConnector]);

  const handleClearBearerToken = async (connectorId: string) => {
    await runSensitiveAction({ type: "clear-token", connectorId }, async () => {
      setBusyKey(`clear-token:${connectorId}`);
      setDetailError(null);
      setDetailSetupNotice(null);
      setClearedBearerTokenConnectorId(null);
      try {
        const saved = await updateMcpConnector(connectorId, {
          bearerToken: null,
        });
        replaceConnector(saved, { preserveToolsOnEmpty: true });
        setDetailDraft((prev) => ({
          ...prev,
          bearerToken: "",
        }));
        setClearedBearerTokenConnectorId(connectorId);
      } finally {
        setBusyKey(null);
      }
    });
  };

  // Aborts a reconnect's in-flight OAuth wait. Same mechanism closeAddModal
  // uses for the add flow: rejecting the wait with McpOAuthCancelledError,
  // which handleRefresh treats as "abandoned on purpose", not a failure.
  const cancelReconnectOAuth = () => {
    oauthAbortRef.current?.abort();
    oauthAbortRef.current = null;
  };

  const handleRefresh = async (connectorId: string) => {
    await runSensitiveAction({ type: "refresh", connectorId }, async () => {
      setBusyKey(`refresh:${connectorId}`);
      try {
        try {
          replaceConnector(await refreshMcpConnectorTools(connectorId));
        } catch (err) {
          if (err instanceof MikeApiError && err.code === "oauth_required") {
            // COOP-strict providers make the consent popup's fate
            // unobservable, so without an explicit escape hatch a
            // closed popup would leave the Refresh button stuck
            // busy for the full five-minute timeout. Surface the
            // Cancel affordance while the wait runs, and treat a
            // user-initiated cancel as a quiet reset rather than
            // an error.
            setReconnectingConnectorId(connectorId);
            try {
              await connectConnectorOAuth(connectorId);
            } catch (oauthErr) {
              if (oauthErr instanceof McpOAuthCancelledError) {
                return;
              }
              throw oauthErr;
            } finally {
              setReconnectingConnectorId((current) =>
                current === connectorId ? null : current,
              );
            }
            return;
          }
          throw err;
        }
      } finally {
        setBusyKey(null);
      }
    });
  };

  const handleConnectorEnabled = async (
    connectorId: string,
    enabled: boolean,
  ) => {
    await runSensitiveAction(
      { type: "connector-enabled", connectorId, enabled },
      async () => {
        setBusyKey(`connector:${connectorId}`);
        try {
          replaceConnector(await updateMcpConnector(connectorId, { enabled }), {
            preserveToolsOnEmpty: true,
          });
        } finally {
          setBusyKey(null);
        }
      },
    );
  };

  const handleRequireWriteApproval = async (
    connectorId: string,
    enabled: boolean,
  ) => {
    await runSensitiveAction(
      { type: "write-approval", connectorId, enabled },
      async () => {
        setBusyKey(`approval:${connectorId}`);
        try {
          replaceConnector(
            await updateMcpConnector(connectorId, {
              requireWriteApproval: enabled,
            }),
            { preserveToolsOnEmpty: true },
          );
        } finally {
          setBusyKey(null);
        }
      },
    );
  };

  const handleReadOnly = async (connectorId: string, enabled: boolean) => {
    await runSensitiveAction(
      { type: "read-only", connectorId, enabled },
      async () => {
        setBusyKey(`read-only:${connectorId}`);
        try {
          replaceConnector(await updateMcpConnector(connectorId, { readOnly: enabled }), {
            preserveToolsOnEmpty: true,
          });
        } finally {
          setBusyKey(null);
        }
      },
    );
  };

  const handleToolEnabled = async (
    connectorId: string,
    toolId: string,
    enabled: boolean,
  ) => {
    await runSensitiveAction(
      { type: "tool-enabled", connectorId, toolId, enabled },
      async () => {
        setBusyKey(`tool:${toolId}`);
        try {
          replaceConnector(
            await setMcpToolEnabled(connectorId, toolId, enabled),
          );
        } finally {
          setBusyKey(null);
        }
      },
    );
  };

  const handleDelete = async (connectorId: string) => {
    await runSensitiveAction({ type: "delete", connectorId }, async () => {
      setBusyKey(`delete:${connectorId}`);
      try {
        await deleteMcpConnector(connectorId);
        setConnectors((prev) => prev.filter((item) => item.id !== connectorId));
        if (selectedConnectorId === connectorId) {
          setSelectedConnectorId(null);
          setSelectedConnectorDetails(null);
        }
      } finally {
        setBusyKey(null);
      }
    });
  };

  const handleAddPreset = async (
    preset: (typeof CONNECTOR_PRESETS)[number],
  ) => {
    const draft = {
      ...emptyAddDraft,
      name: preset.name,
      serverUrl: preset.serverUrl,
    };
    setInstallingPresetUrl(draft.serverUrl);
    try {
      await handleCreate(draft, "page");
    } finally {
      setInstallingPresetUrl(null);
    }
  };

  const handleMfaVerified = async () => {
    const action = pendingMfaAction;
    setPendingMfaAction(null);
    if (!action) return;
    if (action.type === "create") {
      await handleCreate(action.draft, action.surface);
    }
    if (action.type === "google-add") await handleAddGoogle(action.provider);
    if (action.type === "google-update") await action.retry();
    if (action.type === "read-only") await handleReadOnly(action.connectorId, action.enabled);
    if (action.type === "write-approval") {
      await handleRequireWriteApproval(action.connectorId, action.enabled);
    }
    if (action.type === "save") await handleSaveSelectedConnector();
    if (action.type === "clear-token") {
      await handleClearBearerToken(action.connectorId);
    }
    if (action.type === "refresh") await handleRefresh(action.connectorId);
    if (action.type === "delete") await handleDelete(action.connectorId);
    if (action.type === "connector-enabled") {
      await handleConnectorEnabled(action.connectorId, action.enabled);
    }
    if (action.type === "tool-enabled") {
      await handleToolEnabled(
        action.connectorId,
        action.toolId,
        action.enabled,
      );
    }
  };

  const installedGoogle = googleConnectors.filter(
    (connector) => connector.status?.connected,
  );
  const googleLoading = googleConnectors.some((connector) => connector.loading);
  const googleAdding = googleConnectors.some(
    (connector) => connector.phase !== "idle",
  );
  const selectedMcpView = selectedConnector
    ? mcpDetailsView(selectedConnector)
    : null;
  const selectedGoogleView = selectedGoogle
    ? googleDetailsView(selectedGoogle)
    : null;
  const selectedIsCustom =
    !!selectedConnector && !findConnectorPreset(selectedConnector.serverUrl);

  return (
    <div className="@container">
      <section aria-labelledby="installed-connectors-heading">
        <div className="mb-4 flex items-center justify-between gap-3">
          <SettingsHeading id="installed-connectors-heading">
            Installed
          </SettingsHeading>
          <PillButtonUI
            tone="white"
            size="xs"
            onClick={() => setAddOpen(true)}
            aria-label="Add custom connector"
            className={`h-7 ${LIQUID_GLASS_SUBTLE_CLASS}`}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Custom
          </PillButtonUI>
        </div>
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 @min-[32rem]:grid-cols-2">
          {installedGoogle.map((connector) => (
            <ConnectorRow
              key={connector.provider}
              name={connector.name}
              icon={<GoogleConnectorIcon provider={connector.provider} />}
              enabled={connector.status?.enabled !== false}
              busy={busyKey === `connector:${connector.provider}`}
              onOpen={() => {
                setSelectedGoogleProvider(connector.provider);
                void connector.refresh().catch(() => undefined);
              }}
              onEnabledChange={(enabled) =>
                void runGoogleUpdate(`connector:${connector.provider}`, () =>
                  connector.updateSettings({ enabled }),
                )
              }
            />
          ))}
          {!loading &&
            connectors.map((connector) => {
              const preset = findConnectorPreset(connector.serverUrl);
              return (
                <ConnectorRow
                  key={connector.id}
                  name={connector.name}
                  icon={
                    preset ? (
                      <ConnectorBrandIcon name={preset.name} />
                    ) : undefined
                  }
                  placeholderClassName={connectorPlaceholderClassName(connector)}
                  enabled={connector.enabled}
                  busy={busyKey === `connector:${connector.id}`}
                  onOpen={() => void openConnectorDetails(connector.id)}
                  onEnabledChange={(enabled) =>
                    void handleConnectorEnabled(connector.id, enabled)
                  }
                />
              );
            })}
          {!loading &&
            !googleLoading &&
            connectors.length === 0 &&
            installedGoogle.length === 0 && (
              <div className="@min-[32rem]:col-span-2">
                <GlassCardUI>
                  <div className="p-4">
                    <SettingsDescription>
                      No connectors yet.
                    </SettingsDescription>
                  </div>
                </GlassCardUI>
              </div>
            )}
        </div>
      </section>
      <section className="mt-6" aria-labelledby="discover-connectors-heading">
        <div className="mb-4">
          <SettingsHeading id="discover-connectors-heading">
            Discover
          </SettingsHeading>
        </div>
        <div className="grid grid-cols-1 gap-3 @min-[32rem]:grid-cols-2">
          {googleConnectors.map((connector) => (
            <DiscoverCard
              key={connector.provider}
              name={connector.name}
              icon={<GoogleConnectorIcon provider={connector.provider} />}
              added={!!connector.status?.connected}
              adding={connector.phase === "adding"}
              authorizing={connector.phase === "authorizing"}
              loading={connector.loading}
              disabled={
                busyKey === "create" ||
                (googleAdding && connector.phase === "idle")
              }
              onAdd={() => void handleAddGoogle(connector.provider)}
              onCancel={connector.cancel}
            />
          ))}
          {CONNECTOR_PRESETS.map((preset) => {
            const isAdded = connectors.some(
              (connector) =>
                normalizedServerUrl(connector.serverUrl) ===
                normalizedServerUrl(preset.serverUrl),
            );
            const isAdding =
              busyKey === "create" &&
              installingPresetUrl !== null &&
              normalizedServerUrl(installingPresetUrl) ===
                normalizedServerUrl(preset.serverUrl);
            const isAuthorizing =
              isAdding &&
              authorizingPresetUrl !== null &&
              normalizedServerUrl(authorizingPresetUrl) ===
                normalizedServerUrl(preset.serverUrl);
            return (
              <DiscoverCard
                key={preset.serverUrl}
                name={preset.name}
                icon={<ConnectorBrandIcon name={preset.name} />}
                added={isAdded}
                adding={isAdding && !isAuthorizing}
                authorizing={isAuthorizing}
                loading={loading}
                disabled={(busyKey !== null && !isAdding) || googleAdding}
                onAdd={() => void handleAddPreset(preset)}
                onCancel={cancelReconnectOAuth}
              />
            );
          })}
        </div>
      </section>

      <NewCustomMcpModal
        open={addOpen}
        draft={addDraft}
        step={addStep}
        result={addResult}
        authMessage={addAuthMessage}
        showToken={showAddToken}
        onDraftChange={setAddDraft}
        onShowTokenChange={setShowAddToken}
        onClose={closeAddModal}
        onSubmit={() => handleCreate()}
        onOpenConnector={(connectorId) => {
          void openConnectorDetails(connectorId);
          closeAddModal();
        }}
      />

      <ConnectorDetailsModal
        connector={selectedMcpView}
        busyKey={busyKey}
        toolsLoading={loadingConnectorId === selectedConnectorId}
        details={
          selectedConnector && selectedIsCustom ? (
            <McpConnectorForm
              idPrefix="connector-config"
              draft={detailDraft}
              showToken={showDetailToken}
              tokenPlaceholder={
                selectedConnector.hasAuthConfig
                  ? "Saved token encrypted"
                  : "Bearer token"
              }
              tokenAction={
                selectedConnector.hasAuthConfig ||
                clearedBearerTokenConnectorId === selectedConnector.id
                  ? {
                      label:
                        clearedBearerTokenConnectorId === selectedConnector.id
                          ? "Cleared"
                          : "Clear",
                      loading:
                        busyKey === `clear-token:${selectedConnector.id}`,
                      cleared:
                        clearedBearerTokenConnectorId === selectedConnector.id,
                      onClick: () =>
                        void handleClearBearerToken(selectedConnector.id),
                    }
                  : undefined
              }
              onDraftChange={(next) =>
                setDetailDraft({
                  ...detailDraft,
                  name: next.name,
                  serverUrl: next.serverUrl,
                  bearerToken: next.bearerToken,
                  customHeaders: next.customHeaders,
                })
              }
              onShowTokenChange={setShowDetailToken}
            />
          ) : undefined
        }
        reconnecting={
          !!selectedConnectorId &&
          reconnectingConnectorId === selectedConnectorId
        }
        onClose={() => {
          initializedDetailConnectorIdRef.current = null;
          setSelectedConnectorId(null);
          setSelectedConnectorDetails(null);
        }}
        onRefresh={() =>
          selectedConnector && void handleRefresh(selectedConnector.id)
        }
        onCancelReconnect={cancelReconnectOAuth}
        onDelete={() =>
          selectedConnector && void handleDelete(selectedConnector.id)
        }
        onToolEnabled={(toolId, enabled) =>
          selectedConnector &&
          void handleToolEnabled(selectedConnector.id, toolId, enabled)
        }
        onReadOnly={(enabled) =>
          selectedConnector && void handleReadOnly(selectedConnector.id, enabled)
        }
        onRequireWriteApproval={(enabled) =>
          selectedConnector &&
          void handleRequireWriteApproval(selectedConnector.id, enabled)
        }
      />

      <ConnectorDetailsModal
        connector={selectedGoogleView}
        busyKey={busyKey}
        toolsLoading={false}
        onClose={() => setSelectedGoogleProvider(null)}
        onRefresh={() =>
          selectedGoogle &&
          void runGoogleUpdate(`refresh:${selectedGoogle.provider}`, () =>
            selectedGoogle.refresh().then(() => undefined),
          )
        }
        onDelete={() =>
          selectedGoogle && void handleDeleteGoogle(selectedGoogle)
        }
        onToolEnabled={(toolName, enabled) =>
          selectedGoogle &&
          void runGoogleUpdate(`tool:${toolName}`, () =>
            selectedGoogle.setToolEnabled(toolName, enabled),
          )
        }
        onReadOnly={(readOnly) =>
          selectedGoogle &&
          void runGoogleUpdate(`read-only:${selectedGoogle.provider}`, () =>
            selectedGoogle.updateSettings({ readOnly }),
          )
        }
        onRequireWriteApproval={(requireWriteApproval) =>
          selectedGoogle &&
          void runGoogleUpdate(`approval:${selectedGoogle.provider}`, () =>
            selectedGoogle.updateSettings({ requireWriteApproval }),
          )
        }
      />

      <MfaVerificationPopup
        open={!!pendingMfaAction}
        onCancel={() => setPendingMfaAction(null)}
        onVerified={() => void handleMfaVerified()}
      />
      <WarningPopup
        open={!!addError}
        title="Could not add connector"
        message={addError}
        onClose={() => {
          setAddError(null);
          setAddErrorGuideUrl(null);
        }}
      >
        {addErrorGuideUrl && (
          <ConnectorSetupGuideLink href={addErrorGuideUrl} />
        )}
      </WarningPopup>
      <WarningPopup
        open={!!detailError}
        title="Connector update failed"
        message={detailError}
        onClose={() => setDetailError(null)}
      />
      <WarningPopup
        open={!!detailSetupNotice}
        title="Administrator setup required"
        message={detailSetupNotice}
        onClose={() => setDetailSetupNotice(null)}
      >
        {selectedConnector && (
          <ConnectorSetupGuideLink
            href={connectorSetupGuideUrl(selectedConnector.serverUrl)}
          />
        )}
      </WarningPopup>
    </div>
  );
}

function ConnectorRow({
  name,
  icon,
  placeholderClassName,
  enabled,
  busy,
  onOpen,
  onEnabledChange,
}: {
  name: string;
  icon?: ReactNode;
  placeholderClassName?: string;
  enabled: boolean;
  busy: boolean;
  onOpen: () => void;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <ConnectorCard
      name={name}
      icon={icon}
      placeholderClassName={placeholderClassName}
      onOpen={onOpen}
      action={
        <ToggleSwitchUI
          checked={enabled}
          disabled={busy}
          aria-busy={busy}
          aria-label={`${name} connector`}
          onCheckedChange={onEnabledChange}
        />
      }
    />
  );
}

function DiscoverCard({
  name,
  icon,
  added,
  adding,
  authorizing,
  loading,
  disabled,
  onAdd,
  onCancel,
}: {
  name: string;
  icon: ReactNode;
  added: boolean;
  adding: boolean;
  authorizing: boolean;
  loading: boolean;
  disabled: boolean;
  onAdd: () => void;
  onCancel: () => void;
}) {
  return (
    <ConnectorCard
      name={name}
      icon={icon}
      action={
        <PillButtonUI
          tone="blue"
          size="sm"
          onClick={authorizing ? onCancel : onAdd}
          disabled={loading || added || (!authorizing && (adding || disabled))}
          loading={adding}
          aria-label={
            added
              ? `${name} connector added`
              : authorizing
                ? `Cancel ${name} authorization`
                : `Add ${name} connector`
          }
        >
          {added
            ? "Added"
            : authorizing
              ? "Cancel"
              : adding
                ? "Adding..."
                : "Add"}
        </PillButtonUI>
      }
    />
  );
}
