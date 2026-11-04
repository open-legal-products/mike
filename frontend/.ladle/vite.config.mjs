// Vite settings for the Ladle catalog (npm run catalog / catalog:build).
//
// Ladle applies tsconfig.json's `paths` through vite-tsconfig-paths. The
// shared packages have no node_modules of their own, so resolve their runtime
// dependencies from this application's installed copies as well. Vite applies
// `resolve.alias` before the tsconfig plugin.
import { fileURLToPath } from "node:url";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));

// Keep in step with packages/*/package.json peerDependencies.
const SHARED_DEPENDENCIES = [
    "react",
    "react-dom",
    "clsx",
    "tailwind-merge",
    "lucide-react",
    "@radix-ui/react-dropdown-menu",
];

/** @type {import("vite").UserConfig} */
const config = {
    resolve: {
        alias: [
            // The shared packages themselves. vite-tsconfig-paths only maps
            // imports from files tsconfig.json includes relative to this
            // directory, which leaves a package importing its sibling
            // (@mike/ui -> @mike/client) unresolved; alias both outright.
            { find: /^@mike\/ui$/, replacement: here("../../packages/ui/src/index.ts") },
            { find: /^@mike\/client$/, replacement: here("../../packages/client/src/index.ts") },
            ...SHARED_DEPENDENCIES.flatMap((name) => [
                // The package entry, and any subpath (react/jsx-runtime,
                // react-dom/client), from frontend/node_modules.
                { find: new RegExp(`^${name}$`), replacement: here(`../node_modules/${name}`) },
                {
                    find: new RegExp(`^${name}/(.*)$`),
                    replacement: `${here(`../node_modules/${name}`)}/$1`,
                },
            ]),
        ],
    },
    server: {
        fs: {
            // The dev server serves the shared packages from the repository.
            allow: [here("..")],
        },
    },
};

export default config;
