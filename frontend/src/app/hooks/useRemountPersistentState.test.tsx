import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    REMOUNT_PERSISTENCE_MS,
    useRemountPersistentState,
} from "./useRemountPersistentState";

function TestState({ stateKey }: { stateKey: string }) {
    const [value, setValue] = useRemountPersistentState(stateKey, "idle");
    return <button onClick={() => setValue("uploading")}>{value}</button>;
}

describe("useRemountPersistentState", () => {
    afterEach(() => vi.useRealTimers());

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
});
