/** @type {import("@ladle/react").UserConfig} */
export default {
    // Scoped to the shared primitives on purpose (issue #323). The other ~140
    // components under src/app/components/ are feature code, not primitives,
    // and cataloguing them wholesale is not the goal.
    stories: "src/app/components/ui/*.stories.tsx",
    addons: {
        // The primitives carry an explicit accessibility baseline
        // (docs/design-system.md), so the a11y panel is the addon that earns
        // its keep here.
        a11y: { enabled: true },
        // Nothing in components/ui/ is RTL-aware or does data fetching yet.
        rtl: { enabled: false },
        msw: { enabled: false },
    },
};
