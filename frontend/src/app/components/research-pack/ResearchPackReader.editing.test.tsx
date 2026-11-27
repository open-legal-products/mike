import { act } from "react";
import { webcrypto } from "node:crypto";
import { File as NodeFile } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyResearchPackFile } from "@/app/lib/researchPackClient";
import {
    exportMikeEditPackage,
    type MikeEditPackage,
} from "@/app/lib/researchPackEdits";
import { ResearchPackReader } from "./ResearchPackReader";

const localStore = vi.hoisted(() => ({
    records: [] as Array<{ key: string; account_id: string; value: MikeEditPackage }>,
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "account-a" } }),
}));

vi.mock("@/app/lib/researchPackClient", () => ({ verifyResearchPackFile: vi.fn() }));

vi.mock("@/app/lib/researchPackEdits", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/researchPackEdits")>();
    return {
        ...actual,
        listMikeEditPackages: vi.fn(async (accountId: string) =>
            localStore.records.filter((record) => record.account_id === accountId)),
        storeMikeEditPackage: vi.fn(async (accountId: string, value: MikeEditPackage) => {
            const record = {
                key: `${accountId}:${value.package_id}`,
                account_id: accountId,
                value,
            };
            const index = localStore.records.findIndex((item) => item.key === record.key);
            if (index >= 0) localStore.records[index] = record;
            else localStore.records.push(record);
        }),
    };
});

const filename = "assessment-context-r2.research-pack.json";
const source = readFileSync(
    resolve("../tests/fixtures/research-workspace-portable-v02", filename),
    "utf8",
);
const fixture = JSON.parse(source);

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
}

function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
    );
    if (!found) throw new Error(`Button not found: ${label}`);
    return found;
}

function statusContaining(value: string): boolean {
    return Array.from(container.querySelectorAll('[role="status"]')).some((item) =>
        item.textContent?.includes(value),
    );
}

async function openFile(file: File): Promise<void> {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Research Pack file input was not rendered.");
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await flush();
    });
}

async function clickAndFlush(label: string): Promise<void> {
    await act(async () => {
        button(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();
    });
}

async function waitForStatus(value: string): Promise<void> {
    await act(async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
            if (statusContaining(value) || container.querySelector('[role="alert"]')) return;
            await flush();
        }
    });
}

describe("Research Pack editable continuity", () => {
    beforeEach(async () => {
        localStore.records = [];
        Object.defineProperty(globalThis, "File", { configurable: true, value: NodeFile });
        Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
        Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
            configurable: true,
            value: true,
        });
        vi.mocked(verifyResearchPackFile).mockImplementation(async (file) => {
            const bytes = await file.arrayBuffer();
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            const inputSha = Array.from(new Uint8Array(digest), (part) =>
                part.toString(16).padStart(2, "0"),
            ).join("");
            return {
                file,
                pack: fixture,
                report: { integrity: "pass", input_sha256: inputSha, authenticity: "not_established" },
            };
        });
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => {
            root.render(<ResearchPackReader />);
            await flush();
        });
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
            await flush();
        });
        container.remove();
    });

    it("edits, saves, reopens, and imports the exported Mike package without changing source bytes", async () => {
        const original = new File([source], filename, { type: "application/json" });
        await openFile(original);
        expect(container.textContent).toContain(filename);

        const finding = Array.from(container.querySelectorAll("label")).find((label) =>
            label.textContent?.includes("Finding text"),
        )?.querySelector("textarea");
        if (!finding) throw new Error("Finding editor was not rendered.");
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                "value",
            )?.set;
            setter?.call(finding, "A locally edited finding.");
            finding.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await clickAndFlush("Save local edit");
        await waitForStatus("Saved Mike edit revision 1");
        expect(
            statusContaining("Saved Mike edit revision 1"),
            container.querySelector('[role="alert"]')?.textContent ?? container.textContent,
        ).toBe(true);
        expect(localStore.records).toHaveLength(1);
        expect(localStore.records[0].account_id).toBe("account-a");

        await clickAndFlush("Reopen saved edit");
        await waitForStatus("Reopened saved Mike edit revision 1");
        expect(statusContaining("Reopened saved Mike edit revision 1")).toBe(true);
        const reopenedFinding = Array.from(container.querySelectorAll("label")).find((label) =>
            label.textContent?.includes("Finding text"),
        )?.querySelector("textarea");
        expect(reopenedFinding?.value).toBe("A locally edited finding.");

        const portableEdit = new File([
            exportMikeEditPackage(localStore.records[0].value),
        ], "portable.mike-research-edit.json", { type: "application/json" });
        await openFile(portableEdit);
        await waitForStatus("Imported and reopened Mike edit revision 1");
        expect(statusContaining("Imported and reopened Mike edit revision 1")).toBe(true);
        const importedFinding = Array.from(container.querySelectorAll("label")).find((label) =>
            label.textContent?.includes("Finding text"),
        )?.querySelector("textarea");
        expect(importedFinding?.value).toBe("A locally edited finding.");
        const originalBase64 = localStore.records[0].value.base_pack.contents_base64;
        const originalBytes = Uint8Array.from(atob(originalBase64), (part) => part.charCodeAt(0));
        expect(new TextDecoder().decode(originalBytes)).toBe(source);
    });
});
