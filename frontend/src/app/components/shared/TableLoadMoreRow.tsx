"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

// Extracted from the "Load more" button block that was duplicated verbatim
// between the Tabular Reviews page and ProjectReviewsTable. Renders nothing
// while loading, once there's nothing more to load, or once the list is
// empty (an empty list shows its own empty state instead).
export function TableLoadMoreRow({
    loading,
    hasMore,
    itemCount,
    loadingMore,
    hasError,
    onLoadMore,
    autoLoadOnVisible = false,
}: {
    loading: boolean;
    hasMore: boolean;
    itemCount: number;
    loadingMore: boolean;
    hasError: boolean;
    onLoadMore: () => void;
    autoLoadOnVisible?: boolean;
}) {
    const rowRef = useRef<HTMLDivElement>(null);
    const requestedItemCountRef = useRef<number | null>(null);
    const t = useTranslations("shell.tabela");

    useEffect(() => {
        if (
            !autoLoadOnVisible ||
            loading ||
            loadingMore ||
            !hasMore ||
            itemCount === 0 ||
            requestedItemCountRef.current === itemCount ||
            typeof IntersectionObserver === "undefined"
        ) {
            return;
        }

        const row = rowRef.current;
        if (!row) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                requestedItemCountRef.current = itemCount;
                observer.disconnect();
                onLoadMore();
            },
            { rootMargin: "0px 0px 80px 0px" },
        );
        observer.observe(row);
        return () => observer.disconnect();
    }, [
        autoLoadOnVisible,
        hasMore,
        itemCount,
        loading,
        loadingMore,
        onLoadMore,
    ]);

    if (loading || !hasMore || itemCount === 0) return null;

    return (
        <div ref={rowRef} className="flex justify-center py-3">
            <button
                onClick={onLoadMore}
                disabled={loadingMore}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
                {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
                {loadingMore
                    ? t("carregando")
                    : hasError
                      ? t("tentarNovamente")
                      : t("carregarMais")}
            </button>
        </div>
    );
}
