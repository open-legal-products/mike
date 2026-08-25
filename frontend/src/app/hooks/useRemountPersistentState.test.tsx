import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useRemountPersistentState } from "./useRemountPersistentState";

function TestState({ stateKey }: { stateKey: string }) {
    const [value, setValue] = useRemountPersistentState(stateKey, "idle");
    return <button onClick={() => setValue("uploading")}>{value}</button>;
}

describe("useRemountPersistentState", () => {
    it("restores state when a component remounts with the same key", () => {
        const stateKey = `upload-test:${crypto.randomUUID()}`;
        const firstRender = render(<TestState stateKey={stateKey} />);

        fireEvent.click(screen.getByRole("button"));
        expect(screen.getByRole("button")).toHaveTextContent("uploading");

        firstRender.unmount();
        render(<TestState stateKey={stateKey} />);

        expect(screen.getByRole("button")).toHaveTextContent("uploading");
    });
});
