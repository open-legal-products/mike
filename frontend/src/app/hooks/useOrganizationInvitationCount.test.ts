import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listMyOrgInvitations, type OrgInvitation } from "@/app/lib/mikeApi";
import {
    notifyOrganizationInvitationsChanged,
    useOrganizationInvitationCount,
} from "./useOrganizationInvitationCount";

vi.mock("@/app/lib/mikeApi", () => ({ listMyOrgInvitations: vi.fn() }));
const pending = [{ id: "invite-1" }] as OrgInvitation[];

beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listMyOrgInvitations).mockResolvedValue([]);
});

describe("useOrganizationInvitationCount", () => {
    it("does not fetch without a signed-in user", () => {
        const { result } = renderHook(() => useOrganizationInvitationCount(undefined));
        expect(result.current).toBe(0);
        expect(listMyOrgInvitations).not.toHaveBeenCalled();
    });

    it("refreshes on return to settings and retains the last count on failure", async () => {
        const { result } = renderHook(() => useOrganizationInvitationCount("me"));
        await waitFor(() => expect(listMyOrgInvitations).toHaveBeenCalledOnce());
        vi.mocked(listMyOrgInvitations).mockResolvedValue(pending);
        await act(async () => window.dispatchEvent(new Event("focus")));
        expect(result.current).toBe(1);

        vi.mocked(listMyOrgInvitations).mockRejectedValue(new Error("offline"));
        await act(async () => document.dispatchEvent(new Event("visibilitychange")));
        expect(result.current).toBe(1);
    });

    it("does not let an older fetch restore an answered invitation", async () => {
        let finishOldRequest!: (invitations: OrgInvitation[]) => void;
        vi.mocked(listMyOrgInvitations).mockReturnValueOnce(new Promise((resolve) => {
            finishOldRequest = resolve;
        }));
        const { result } = renderHook(() => useOrganizationInvitationCount("me"));
        await act(async () => notifyOrganizationInvitationsChanged());
        await act(async () => finishOldRequest(pending));
        expect(result.current).toBe(0);
    });

    it("hides the previous account's count while the new account loads", async () => {
        vi.mocked(listMyOrgInvitations).mockResolvedValueOnce(pending);
        const { result, rerender } = renderHook(
            ({ userId }) => useOrganizationInvitationCount(userId),
            { initialProps: { userId: "me" } },
        );
        await waitFor(() => expect(result.current).toBe(1));
        vi.mocked(listMyOrgInvitations).mockReturnValue(new Promise(() => {}));
        rerender({ userId: "another-user" });
        expect(result.current).toBe(0);
    });
});
