import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => ({
    current: {
        governedByOrganization: false,
        quickActionsVisible: undefined as boolean | undefined,
        responseDetailsVisible: undefined,
        tabularModel: undefined,
    },
}));
vi.mock("@/app/hooks/useWorkspacePreferences", () => ({
    useWorkspacePreferences: () => prefs.current,
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: null }),
}));
vi.mock("./ChatInput", () => ({ ChatInput: () => <div /> }));

import { InitialView } from "./InitialView";

const configure = () =>
    screen.queryByRole("button", { name: "Configure quick actions" });

function renderView() {
    return render(
        <InitialView
            {...({
                quickActions: [],
                onEditQuickActions: () => {},
            } as unknown as React.ComponentProps<typeof InitialView>)}
        />,
    );
}

beforeEach(() => {
    prefs.current = {
        governedByOrganization: false,
        quickActionsVisible: undefined,
        responseDetailsVisible: undefined,
        tabularModel: undefined,
    };
});

describe("InitialView quick actions", () => {
    it("shows them in Personal before the profile has loaded, as before", () => {
        renderView();
        expect(configure()).toBeInTheDocument();
    });

    it("hides them in an organization until its setting is known", () => {
        prefs.current.governedByOrganization = true;
        renderView();
        expect(configure()).toBeNull();
    });

    it("follows the organization's setting once known", () => {
        prefs.current.governedByOrganization = true;
        prefs.current.quickActionsVisible = false;
        const { unmount } = renderView();
        expect(configure()).toBeNull();
        unmount();

        prefs.current.quickActionsVisible = true;
        renderView();
        expect(configure()).toBeInTheDocument();
    });
});
