import { parseEditKey } from "./wordTrackedEditKeys";
import type { EditRuntimeState } from "./wordChatTypes";

export const EMPTY_MESSAGE_EDIT_STATE: Readonly<Record<string, EditRuntimeState>> = Object.freeze({});

/** Reuse each untouched message's state object when another card changes. */
export function createMessageEditStateSelector() {
  let previous = new Map<string, Readonly<Record<string, EditRuntimeState>>>();
  return (state: Readonly<Record<string, EditRuntimeState>>) => {
    const grouped = new Map<string, Record<string, EditRuntimeState>>();
    for (const [key, value] of Object.entries(state)) {
      const parsed = parseEditKey(key);
      if (!parsed) continue;
      const group = grouped.get(parsed.messageId) ?? {};
      group[key] = value;
      grouped.set(parsed.messageId, group);
    }
    const result = new Map<string, Readonly<Record<string, EditRuntimeState>>>();
    for (const [id, group] of grouped) {
      const old = previous.get(id);
      const keys = Object.keys(group);
      result.set(id, old && keys.length === Object.keys(old).length && keys.every(key => old[key] === group[key]) ? old : group);
    }
    previous = result;
    return result;
  };
}
