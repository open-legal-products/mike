import React, { useMemo } from "react";
import { Search } from "lucide-react";
import { Spinner } from "../../../shared/ui/spinner";

export interface PickerListItem {
  id: string;
  title: string;
  /** Secondary text at the row's right edge, such as a practice area. */
  meta?: string | null;
  /** Everything the search box matches against; defaults to title + meta. */
  searchText?: string;
  /** Shown but not selectable, such as a workflow with no prompt. */
  disabled?: boolean;
}

interface PickerListProps {
  items: PickerListItem[];
  search: string;
  onSearchChange: (search: string) => void;
  onSelect: (id: string) => void;
  /** Search box placeholder, e.g. "Search workflows...". */
  searchPlaceholder: string;
  /** Spinner label while loading, e.g. "Loading workflows…". */
  loadingLabel: string;
  emptyMessage: string;
  loading?: boolean;
  error?: string | null;
  /**
   * The load failed and a toast already says so (with Retry): show no list
   * and no "nothing found" copy, which would claim there are none.
   */
  loadFailed?: boolean;
  selectedId?: string;
}

/**
 * The searchable single-select list inside the composer's pickers (workflows
 * and playbooks): a search field over rows that toggle `aria-pressed`.
 */
export function PickerList({
  items,
  search,
  onSearchChange,
  onSelect,
  searchPlaceholder,
  loadingLabel,
  emptyMessage,
  loading = false,
  error = null,
  loadFailed = false,
  selectedId,
}: PickerListProps): React.ReactElement {
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      (item.searchText ?? [item.title, item.meta ?? ""].join(" "))
        .toLowerCase()
        .includes(query),
    );
  }, [search, items]);

  return (
    <>
      <label className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-white/70 bg-white/70 px-3 text-gray-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_7px_rgba(15,23,42,0.05)]">
        <Search className="h-3.5 w-3.5" />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="min-w-0 flex-1 border-0 bg-transparent text-xs text-gray-800 outline-none placeholder:text-gray-400"
        />
      </label>
      <div data-modal-scroll="vertical" className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-sm pb-3">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label={loadingLabel} />
          </div>
        ) : loadFailed ? null : error ? (
          <p className="py-8 text-center text-sm text-destructive">{error}</p>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">
            {search ? "No matches found" : emptyMessage}
          </p>
        ) : (
          <div className="space-y-px">
            {filtered.map((item) => {
              const isSelected = selectedId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={isSelected}
                  disabled={item.disabled}
                  onClick={() => onSelect(item.id)}
                  className={`flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-2.5 text-left text-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${
                    isSelected
                      ? "bg-gray-200 text-gray-900"
                      : "text-gray-700 hover:bg-gray-100"
                  } ${item.disabled ? "cursor-not-allowed opacity-45" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {item.title}
                  </span>
                  {item.meta && (
                    <span className="max-w-[40%] shrink-0 truncate text-right text-[11px] text-gray-400">
                      {item.meta}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
