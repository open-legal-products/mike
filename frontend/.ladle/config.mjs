/** @type {import("@ladle/react").UserConfig} */
const config = {
    // Scoped to the two primitive collections on purpose (issue #323). The
    // other ~140 app components are feature code, not primitives, and
    // cataloguing them wholesale is not the goal.
    stories:
        "src/{app/components/ui,shared/ui}/stories/*.stories.tsx",
    addons: {
        // The primitives carry an explicit accessibility baseline
        // (docs/design-system.md), so the a11y panel is the addon that earns
        // its keep here.
        a11y: { enabled: true },
        // Nothing in either primitive collection fetches data.
        rtl: { enabled: false },
        msw: { enabled: false },
    },
};

export default config;
