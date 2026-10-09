// The Word add-in's adapter onto the model catalog it shares with the web app
// (@mike/model-catalog = frontend/src/shared/lib/modelCatalog.ts). The
// catalog, router Model Selections, picker rows and availability rules all
// live there; only what is specific to the add-in is here: its key status is
// GET /user/api-keys as a flat boolean map, and an unknown status (null, the
// preflight failed even after a retry) fails open.
//
// Imported from the pure types module (not the API client, whose runtime
// imports include the Sentry SDK) so this module's compile graph stays free
// of Office globals and add-in-only packages: tests in frontend/src/wordAddin
// import this file across packages.
import {
  isModelAvailable as isModelAvailableForKeys,
  noModelsReason as noModelsReasonForKeys,
  unavailableModelMessage as unavailableModelMessageForKeys,
  type NoModelsReason,
  type ProviderKeyStates,
  type RouterSelections,
} from "@mike/model-catalog";
import type { ApiKeyStatus } from "../types";

/** GET /user/api-keys' flat map in the shape the shared rules read. */
export function providerKeyStates(status: ApiKeyStatus): ProviderKeyStates {
  const { sources: _sources, enabled = {}, ...configured } = status;
  const providers = new Set([
    ...Object.keys(configured),
    ...Object.keys(enabled),
  ]) as Set<keyof typeof enabled>;
  return Object.fromEntries(
    [...providers].map((provider) => [
      provider,
      {
        configured: configured[provider as keyof typeof configured] === true,
        enabled: enabled[provider],
      },
    ]),
  );
}

export function isModelAvailable(
  modelId: string,
  status: ApiKeyStatus | null,
): boolean {
  // Unknown status fails OPEN: the backend authoritatively rejects a model
  // it cannot serve, so blocking sends here on a flaky WKWebView request
  // would brick the composer for requests the backend would happily accept.
  return !status || isModelAvailableForKeys(modelId, providerKeyStates(status));
}

/** Why the composer cannot send with a model the picker does not offer. */
export function unavailableModelMessage(
  modelId: string,
  status: ApiKeyStatus | null,
): string {
  return unavailableModelMessageForKeys(
    modelId,
    status ? providerKeyStates(status) : {},
  );
}

/** Why the picker is empty. */
export function noModelsReason(
  status: ApiKeyStatus | null,
  selections: Partial<RouterSelections>,
): NoModelsReason {
  return noModelsReasonForKeys(
    status ? providerKeyStates(status) : null,
    selections,
  );
}
