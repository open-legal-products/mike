import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
    mergeAccessContacts,
    PermissionDeniedPopup,
} from "./PermissionDeniedPopup";

describe("PermissionDeniedPopup", () => {
    it("speaks in the roles the product exposes", () => {
        render(
            <PermissionDeniedPopup
                open
                action="delete this project"
                onClose={vi.fn()}
            />,
        );
        expect(screen.getByText("Admin-only action")).toBeInTheDocument();
        expect(
            screen.getByText("Only an admin can delete this project."),
        ).toBeInTheDocument();
    });

    it("uses the member tier for actions a viewer cannot take", () => {
        render(
            <PermissionDeniedPopup
                open
                action="upload documents"
                requiredRole="member"
                onClose={vi.fn()}
            />,
        );
        expect(screen.getByText("Members only")).toBeInTheDocument();
        expect(
            screen.getByText("Only a member can upload documents."),
        ).toBeInTheDocument();
    });

    it("names the first contact who has an address", () => {
        // The bug this fixes: the popup used to guard its contact line on a
        // field the project endpoint never returned, so a refused user was
        // never told who to ask. The server now ranks admin contacts —
        // creator first — and the first one with an email is offered.
        render(
            <PermissionDeniedPopup
                open
                action="change sharing"
                contacts={[
                    {
                        email: null,
                        display_name: "Deleted Account",
                    },
                    {
                        email: "partner@firm.example",
                        display_name: "A Partner",
                    },
                    {
                        email: "second@firm.example",
                        display_name: null,
                    },
                ]}
                onClose={vi.fn()}
            />,
        );
        expect(
            screen.getByText("A Partner (partner@firm.example)"),
        ).toBeInTheDocument();
        expect(
            screen.queryByText(/second@firm.example/),
        ).not.toBeInTheDocument();
    });

    it("falls back to the bare address when there is no display name", () => {
        render(
            <PermissionDeniedPopup
                open
                action="change sharing"
                contacts={[{ email: "partner@firm.example" }]}
                onClose={vi.fn()}
            />,
        );
        expect(
            screen.getByText("partner@firm.example"),
        ).toBeInTheDocument();
    });

    it("omits the contact line when nobody can be named", () => {
        render(
            <PermissionDeniedPopup
                open
                action="change sharing"
                contacts={[{ email: null, display_name: null }]}
                onClose={vi.fn()}
            />,
        );
        expect(screen.queryByText(/if you need/)).not.toBeInTheDocument();
    });

    it("states a rule no role can lift, without an ask-somebody line", () => {
        // Chat rename/delete are creator-only server-side, so the default
        // "Only an admin can …" copy would have named a tier that cannot
        // help — and there is nobody to ask, because nobody can grant it.
        render(
            <PermissionDeniedPopup
                open
                title="Chat creator only"
                message="Only the person who started this chat can rename it."
                onClose={vi.fn()}
            />,
        );
        expect(screen.getByText("Chat creator only")).toBeInTheDocument();
        expect(
            screen.getByText(
                "Only the person who started this chat can rename it.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByText(/Only an admin/)).not.toBeInTheDocument();
        expect(screen.queryByText(/if you need/)).not.toBeInTheDocument();
    });

    it("renders nothing when closed", () => {
        const { container } = render(
            <PermissionDeniedPopup open={false} onClose={vi.fn()} />,
        );
        expect(container).toBeEmptyDOMElement();
    });
});

describe("mergeAccessContacts", () => {
    it("keeps server order, drops repeats and entries with no address", () => {
        // A bulk refusal spans several rows and the same admin usually
        // appears on all of them; the popup still has to name exactly one.
        expect(
            mergeAccessContacts([
                [
                    { email: null, display_name: "Deleted Account" },
                    { email: "Dana@firm.test", display_name: "Dana" },
                ],
                null,
                [
                    { email: "dana@firm.test", display_name: "Dana" },
                    { email: "sam@firm.test", display_name: "Sam" },
                ],
                undefined,
            ]),
        ).toEqual([
            { email: "Dana@firm.test", display_name: "Dana" },
            { email: "sam@firm.test", display_name: "Sam" },
        ]);
    });

    it("returns nothing when no row could name anyone", () => {
        expect(mergeAccessContacts([null, undefined, []])).toEqual([]);
    });
});
