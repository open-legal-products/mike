import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    REMOUNT_PERSISTENCE_MS,
    useRemountPersistentState,
} from "./useRemountPersistentState";

function TestState({
    stateKey,
    initialValue = "idle",
}: {
    stateKey: string;
    initialValue?: string;
}) {
    const [value, setValue] = useRemountPersistentState(stateKey, initialValue);
    return <button onClick={() => setValue("uploading")}>{value}</button>;
}

describe("useRemountPersistentState", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("restores state when a component remounts with the same key", () => {
        const stateKey = `upload-test:${crypto.randomUUID()}`;
        const firstRender = render(<TestState stateKey={stateKey} />);

        fireEvent.click(screen.getByRole("button"));
        expect(screen.getByRole("button")).toHaveTextContent("uploading");

        firstRender.unmount();
        render(<TestState stateKey={stateKey} />);

        expect(screen.getByRole("button")).toHaveTextContent("uploading");
    });

    it("evicts inactive state after the remount grace period", () => {
        vi.useFakeTimers();
        const stateKey = `upload-test:${crypto.randomUUID()}`;
        const firstRender = render(<TestState stateKey={stateKey} />);

        fireEvent.click(screen.getByRole("button"));
        firstRender.unmount();
        act(() => vi.advanceTimersByTime(REMOUNT_PERSISTENCE_MS));

        render(<TestState stateKey={stateKey} />);
        expect(screen.getByRole("button")).toHaveTextContent("idle");
    });

    it("keeps server renders out of the module-level store", () => {
        const stateKey = `upload-test:${crypto.randomUUID()}`;

        vi.stubGlobal("window", undefined);
        renderToString(<TestState stateKey={stateKey} />);
        vi.unstubAllGlobals();

        // A server render that cached its entry would answer this render with
        // the stored "idle" — and would keep that entry for the lifetime of the
        // Node process, because eviction only runs from subscribe teardown,
        // which the server never reaches.
        render(<TestState stateKey={stateKey} initialValue="fresh" />);
        expect(screen.getByRole("button")).toHaveTextContent("fresh");
    });
});
