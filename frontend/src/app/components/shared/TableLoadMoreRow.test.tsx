import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { TableLoadMoreRow } from "./TableLoadMoreRow";

let intersectionCallback:
    | ((entries: Array<{ isIntersecting: boolean }>) => void)
    | undefined;
const observe = vi.fn();
const disconnect = vi.fn();

describe("TableLoadMoreRow", () => {
    beforeEach(() => {
        intersectionCallback = undefined;
        observe.mockClear();
        disconnect.mockClear();
        vi.stubGlobal(
            "IntersectionObserver",
            class {
                constructor(
                    callback: (
                        entries: Array<{ isIntersecting: boolean }>,
                    ) => void,
                ) {
                    intersectionCallback = callback;
                }

                observe = observe;
                disconnect = disconnect;
            },
        );
    });

    afterEach(() => vi.unstubAllGlobals());

    it("loads automatically when an enabled row reaches the viewport", () => {
        const onLoadMore = vi.fn();
        render(
            withIntl(
                <TableLoadMoreRow
                    autoLoadOnVisible
                    loading={false}
                    hasMore
                    itemCount={10}
                    loadingMore={false}
                    hasError={false}
                    onLoadMore={onLoadMore}
                />,
            ),
        );

        expect(observe).toHaveBeenCalledTimes(1);
        act(() => intersectionCallback?.([{ isIntersecting: false }]));
        expect(onLoadMore).not.toHaveBeenCalled();

        act(() => intersectionCallback?.([{ isIntersecting: true }]));
        expect(onLoadMore).toHaveBeenCalledTimes(1);
        expect(disconnect).toHaveBeenCalled();
    });

    it("retains the manual load-more fallback", () => {
        const onLoadMore = vi.fn();
        render(
            withIntl(
                <TableLoadMoreRow
                    loading={false}
                    hasMore
                    itemCount={10}
                    loadingMore={false}
                    hasError={false}
                    onLoadMore={onLoadMore}
                />,
            ),
        );

        fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
        expect(onLoadMore).toHaveBeenCalledTimes(1);
        expect(observe).not.toHaveBeenCalled();
    });
});
