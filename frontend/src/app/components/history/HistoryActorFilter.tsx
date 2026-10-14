"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { getAuditActors, type AuditActor } from "@/app/lib/mikeApi";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import { SearchBar } from "@/app/components/ui/search-bar";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { DropdownButton, DropdownSurface } from "@/shared/ui/dropdown";
import { textButtonUIClassName } from "@/shared/ui/TextButtonUI.styles";

/** Search and select an exact audit actor, loading additional people on scroll. */
export function HistoryActorFilter({
  orgId,
  value,
  onChange,
}: {
  orgId: string;
  value: AuditActor | null;
  onChange: (value: AuditActor | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<AuditActor[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorOffset, setErrorOffset] = useState<number | null>(null);
  const request = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (offset: number) => {
      if (request.current) return;
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setErrorOffset(null);
      try {
        const page = await getAuditActors(
          { orgId, search: search.trim(), offset },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setUsers((current) =>
          offset === 0
            ? page.users
            : [
                ...current,
                ...page.users.filter(
                  (user) =>
                    !current.some((row) => row.user_id === user.user_id),
                ),
              ],
        );
        setNextOffset(page.nextOffset);
      } catch {
        if (!controller.signal.aborted) setErrorOffset(offset);
      } finally {
        if (request.current === controller) {
          request.current = null;
          setLoading(false);
        }
      }
    },
    [orgId, search],
  );

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    if (!open) return;
    setUsers([]);
    setNextOffset(null);
    setErrorOffset(null);
    setLoading(true);
    if (list.current) list.current.scrollTop = 0;
    const timer = window.setTimeout(() => void load(0), search ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [open, search, load]);

  function choose(user: AuditActor | null) {
    onChange(user);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Filter by person"
          aria-pressed={Boolean(value)}
          title={
            value
              ? `Performed by ${value.display_name || value.email || "Unknown user"}`
              : "Filter by person"
          }
          className={textButtonUIClassName({
            className: `h-[18px] w-[22px] p-0 ${value ? "text-blue-600" : "text-gray-400"}`,
          })}
        >
          <ChevronDown aria-hidden className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Filter by person"
        className="w-80 max-w-[calc(100vw-2rem)] border-0 bg-transparent p-0 shadow-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
      >
        <DropdownSurface className="p-1">
          <div className="p-2">
            <SearchBar
              ref={input}
              size="sm"
              value={search}
              onValueChange={setSearch}
              label="Search people"
              placeholder="Search name or email"
              maxLength={200}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  list.current
                    ?.querySelector<HTMLButtonElement>("[data-person]")
                    ?.focus();
                }
              }}
            />
          </div>
          <div
            ref={list}
            role="group"
            aria-label="People"
            className="max-h-72 overflow-y-auto overscroll-contain"
            onScroll={(event) => {
              const target = event.currentTarget;
              if (
                nextOffset !== null &&
                !loading &&
                errorOffset === null &&
                target.scrollHeight - target.scrollTop - target.clientHeight <
                  40
              )
                void load(nextOffset);
            }}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
                return;
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              ];
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (index < 0) return;
              event.preventDefault();
              if (event.key === "ArrowUp" && index === 0) {
                input.current?.focus();
                return;
              }
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : index + (event.key === "ArrowDown" ? 1 : -1);
              buttons[Math.min(buttons.length - 1, Math.max(0, next))]?.focus();
            }}
          >
            <DropdownButton
              data-person
              aria-pressed={!value}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left"
              onClick={() => choose(null)}
            >
              All people{" "}
              {!value && <Check aria-hidden className="h-3.5 w-3.5" />}
            </DropdownButton>
            {users.map((user) => (
              <DropdownButton
                key={user.user_id}
                data-person
                aria-pressed={value?.user_id === user.user_id}
                className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left"
                onClick={() => choose(user)}
              >
                <UserAvatar
                  name={user.display_name}
                  email={user.email}
                  photo={user.profile_photo}
                />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="block text-gray-800">
                    {user.display_name || user.email || "Unknown user"}
                  </span>
                  {user.display_name && user.email && (
                    <span className="block text-gray-500">{user.email}</span>
                  )}
                </span>
                {value?.user_id === user.user_id && (
                  <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />
                )}
              </DropdownButton>
            ))}
            {loading && !users.length ? (
              <div
                role="status"
                aria-label="Loading people"
                className="space-y-4 px-3 py-2"
              >
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex gap-2">
                    <SkeletonLine className="h-5 w-5 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <SkeletonLine className="h-3 w-24" />
                      <SkeletonLine className="h-3 w-40 max-w-full" />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {!loading && !users.length && errorOffset === null && (
              <p className="px-3 py-4 text-center text-xs text-gray-500">
                No people found.
              </p>
            )}
            {errorOffset !== null ? (
              <div
                role="alert"
                className="px-3 py-3 text-center text-xs text-gray-500"
              >
                Could not load people.
                <DropdownButton
                  className="mt-2 block w-full rounded-lg py-2"
                  onClick={() => void load(errorOffset)}
                >
                  Try again
                </DropdownButton>
              </div>
            ) : nextOffset !== null ? (
              <DropdownButton
                className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2"
                disabled={loading}
                onClick={() => void load(nextOffset)}
              >
                {loading && (
                  <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                )}
                {loading ? "Loading people…" : "Load more people"}
              </DropdownButton>
            ) : null}
          </div>
        </DropdownSurface>
      </PopoverContent>
    </Popover>
  );
}
