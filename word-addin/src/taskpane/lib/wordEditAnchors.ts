/// <reference types="office-js" />

/**
 * Document-local registry for durable Word edit anchors.
 *
 * The stable edit ID comes from the persisted assistant-message UUID plus the
 * redline block index. The bookmark itself lives in Word; this setting tells a
 * reloaded task pane which bookmark belongs to which historical edit card.
 */
import { rememberAppliedEditId } from "./editApplyOutcome";

const WORD_EDIT_ANCHORS_SETTING = "mike.wordEditAnchors.v1";

/**
 * Stable edit IDs this document has already had applied to it, newest last.
 *
 * Applying is not idempotent in Word — applying the same logical edit again
 * inserts a SECOND revision — and a rejoined turn replays every edit frame of
 * its assistant message (see lib/editApplyOutcome). This registry is the
 * document-durable record that lets apply skip a re-delivered edit. It is
 * deliberately separate from the anchor registry: anchors are deleted when
 * an edit is accepted or rejected, but "already applied" must outlive that
 * decision.
 *
 * Only opaque IDs are stored (`${assistantMessageId}:edit-${n}`), never edit
 * text, so the setting adds no document content to the file. The list is
 * capped at MAX_APPLIED_EDIT_IDS (oldest dropped) by rememberAppliedEditId.
 */
const WORD_APPLIED_EDITS_SETTING = "mike.wordAppliedEdits.v1";

interface WordEditAnchor {
  bookmarkName: string;
  createdAt: string;
}

interface PersistedWordEditAnchorRegistry {
  version: 1;
  anchors: Record<string, WordEditAnchor>;
}

const EMPTY_REGISTRY: PersistedWordEditAnchorRegistry = {
  version: 1,
  anchors: {},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRegistry(
  settings: Office.Settings
): PersistedWordEditAnchorRegistry {
  const value = settings.get(WORD_EDIT_ANCHORS_SETTING) as unknown;
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.anchors)) {
    return { ...EMPTY_REGISTRY, anchors: {} };
  }

  const anchors: Record<string, WordEditAnchor> = {};
  for (const [stableEditId, candidate] of Object.entries(value.anchors)) {
    const expectedBookmarkName = bookmarkNameForEdit(stableEditId);
    if (
      isPlainObject(candidate) &&
      candidate.bookmarkName === expectedBookmarkName &&
      typeof candidate.createdAt === "string"
    ) {
      anchors[stableEditId] = {
        bookmarkName: candidate.bookmarkName,
        createdAt: candidate.createdAt,
      };
    }
  }
  return { version: 1, anchors };
}

function saveSettings(settings: Office.Settings): Promise<void> {
  return new Promise((resolve, reject) => {
    settings.saveAsync((result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        resolve();
        return;
      }
      reject(new Error(result.error?.message || "Word could not save edit anchors."));
    });
  });
}

/** A compact deterministic digest using two independent 32-bit FNV-1a passes. */
function stableDigest(value: string): string {
  const hash = (seed: number): string => {
    let result = seed >>> 0;
    for (let index = 0; index < value.length; index++) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 0x01000193) >>> 0;
    }
    return result.toString(16).padStart(8, "0");
  };
  return `${hash(0x811c9dc5)}${hash(0x9e3779b9)}`;
}

/**
 * Word bookmark names are limited to 40 alphanumeric/underscore characters.
 * Leading `_` makes this an invisible bookmark in Word's normal bookmark UI.
 */
export function bookmarkNameForEdit(stableEditId: string): string {
  return `_MikeEdit_${stableDigest(stableEditId)}`;
}

/**
 * Drop the entire anchor registry from the settings working copy WITHOUT
 * saving. Used when copy detection mints a fresh document identity: the
 * registry keys reference the original document's chat history, so it is
 * stale in the copy. The caller batches this into its own saveAsync.
 */
export function clearWordEditAnchorRegistry(settings: Office.Settings): void {
  settings.remove(WORD_EDIT_ANCHORS_SETTING);
  // The applied-edit IDs are keyed by the original document's chat history
  // too, so a fresh identity must start with an empty set.
  settings.remove(WORD_APPLIED_EDITS_SETTING);
}

function readAppliedEditIds(settings: Office.Settings): string[] {
  const value = settings.get(WORD_APPLIED_EDITS_SETTING) as unknown;
  if (!isPlainObject(value) || value.version !== 1) return [];
  const ids = (value as { ids?: unknown }).ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && !!id);
}

/** Every stable edit ID already applied to this document. */
export function listAppliedWordEditIds(): ReadonlySet<string> {
  return new Set(readAppliedEditIds(Office.context.document.settings));
}

/**
 * Record that `stableEditId` now exists in the document as a real revision.
 * Best effort: failing to persist the marker only costs idempotency on a
 * later retry, never the edit itself, so callers do not surface a failure.
 */
export async function markWordEditApplied(stableEditId: string): Promise<void> {
  await persistWordEditState([], [stableEditId]);
}

/** Read/validate once when restoring a whole conversation. */
export function getWordEditAnchors(): Readonly<Record<string, WordEditAnchor>> {
  return readRegistry(Office.context.document.settings).anchors;
}

/** Commit the anchors and replay markers for one serialized Word mutation together. */
export async function persistWordEditState(
  anchors: readonly { stableEditId: string; bookmarkName: string }[],
  appliedIds: readonly string[],
): Promise<void> {
  // Validate the complete input before changing the Office settings working copy.
  for (const anchor of anchors) {
    if (anchor.bookmarkName !== bookmarkNameForEdit(anchor.stableEditId)) {
      throw new Error("Word edit anchor name does not match its stable edit ID.");
    }
  }
  const settings = Office.context.document.settings;
  let changed = false;
  if (anchors.length) {
    const registry = readRegistry(settings);
    const createdAt = new Date().toISOString();
    for (const anchor of anchors) registry.anchors[anchor.stableEditId] = {
      bookmarkName: anchor.bookmarkName, createdAt,
    };
    settings.set(WORD_EDIT_ANCHORS_SETTING, registry);
    changed = true;
  }
  if (appliedIds.length) {
    let ids = readAppliedEditIds(settings);
    const known = new Set(ids);
    for (const id of appliedIds) {
      if (known.has(id)) continue;
      known.add(id);
      ids = rememberAppliedEditId(ids, id);
      changed = true;
    }
    if (changed) settings.set(WORD_APPLIED_EDITS_SETTING, { version: 1, ids });
  }
  if (changed) await saveSettings(settings);
}

export function getWordEditAnchor(stableEditId: string): WordEditAnchor | null {
  const settings = Office.context.document.settings;
  const anchor = readRegistry(settings).anchors[stableEditId];
  return anchor ? { ...anchor } : null;
}

/**
 * Registered stable edit IDs starting with `prefix`. A replace-all edit
 * persists one anchor per applied occurrence under `${cardKey}#${pass}`, and
 * this is how a reloaded pane discovers how many passes were applied.
 */
export function listWordEditAnchorIds(prefix: string): string[] {
  const settings = Office.context.document.settings;
  return Object.keys(readRegistry(settings).anchors).filter((id) =>
    id.startsWith(prefix),
  );
}

export async function persistWordEditAnchor(stableEditId: string, bookmarkName: string): Promise<void> {
  await persistWordEditState([{ stableEditId, bookmarkName }], []);
}

export async function removeWordEditAnchor(stableEditId: string): Promise<void> {
  await removeWordEditAnchors([stableEditId]);
}

/** Remove a whole resolved/restored batch with one registry traversal and save. */
export async function removeWordEditAnchors(stableEditIds: readonly string[]): Promise<void> {
  if (!stableEditIds.length) return;
  const settings = Office.context.document.settings;
  const raw = settings.get(WORD_EDIT_ANCHORS_SETTING) as unknown;
  const rawAnchors = isPlainObject(raw) && isPlainObject(raw.anchors) ? raw.anchors : {};
  const registry = readRegistry(settings);
  let changed = false;
  for (const id of stableEditIds) {
    changed = Object.prototype.hasOwnProperty.call(rawAnchors, id) || changed;
    delete registry.anchors[id];
  }
  if (!changed) return;
  if (Object.keys(registry.anchors).length) settings.set(WORD_EDIT_ANCHORS_SETTING, registry);
  else settings.remove(WORD_EDIT_ANCHORS_SETTING);
  await saveSettings(settings);
}
