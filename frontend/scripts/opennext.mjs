#!/usr/bin/env node
// Runs `opennextjs-cloudflare <command>` for each command given, in order:
//
//     node scripts/opennext.mjs build deploy
//
// OpenNext takes the nearest directory with a lockfile as the project root.
// This app's lockfiles sit in frontend/, so OpenNext would treat frontend/ as
// the root. Next.js traces from the repository root instead (next.config.ts
// sets turbopack.root so the shared packages/ resolve), and writes the
// standalone server under .next/standalone/frontend/. OpenNext then looks for
// it under .next/standalone/ and the build fails.
//
// OpenNext has no setting for its root, so this script moves frontend/'s
// lockfiles aside while OpenNext runs. OpenNext then finds the repository's
// package-lock.json and agrees with Next.js. The lockfiles are restored when
// OpenNext exits, fails or is interrupted. When they are already absent (the
// hosted build deletes them first), nothing is moved.
//
// With the repository as its root, OpenNext's build also compiles the
// repository's .env files into the Worker, next to the app's own. Those hold
// the backend's secrets and the Worker has no use for them, so after each
// build this script rewrites that file from frontend/'s .env files alone,
// which are the only ones Next.js itself reads.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Every lockfile OpenNext looks for (@opennextjs/aws findPackagerAndRoot).
export const LOCKFILES = [
    "bun.lockb",
    "bun.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
];
export const HIDDEN_SUFFIX = ".opennext-hidden";

/**
 * Restores lockfiles left aside by a run that was killed before it could
 * restore them. Refuses to continue when both copies exist, because one of
 * them would have to be thrown away.
 */
export function recoverLockfiles(appDir) {
    for (const name of LOCKFILES) {
        const file = path.join(appDir, name);
        const hidden = file + HIDDEN_SUFFIX;
        if (!fs.existsSync(hidden)) continue;
        if (fs.existsSync(file)) {
            throw new Error(
                `Both ${name} and ${name}${HIDDEN_SUFFIX} exist in ${appDir}. ` +
                    `Keep the right one and delete the other, then run this again.`,
            );
        }
        fs.renameSync(hidden, file);
        console.warn(`[opennext] restored ${name} left aside by an interrupted run`);
    }
}

/** Moves the app's lockfiles aside and returns a function that restores them. */
export function hideLockfiles(appDir) {
    const moved = [];
    const restore = () => {
        while (moved.length > 0) {
            const file = moved.pop();
            fs.renameSync(file + HIDDEN_SUFFIX, file);
        }
    };
    try {
        for (const name of LOCKFILES) {
            const file = path.join(appDir, name);
            if (!fs.existsSync(file)) continue;
            fs.renameSync(file, file + HIDDEN_SUFFIX);
            moved.push(file);
        }
    } catch (error) {
        restore();
        throw error;
    }
    return restore;
}

/** OpenNext's own .env reader, so the load order and parsing stay its own. */
async function loadOpenNextEnvReader() {
    // The package only exports its runtime API, so go through the entry point
    // to the CLI module that sits beside it in dist/.
    const entry = createRequire(import.meta.url).resolve("@opennextjs/cloudflare");
    const file = path.resolve(path.dirname(entry), "../cli/utils/extract-project-env-vars.js");
    const { extractProjectEnvVars } = await import(pathToFileURL(file).href);
    return extractProjectEnvVars;
}

/**
 * Rewrites the env file OpenNext's build compiled for the Worker so that it
 * holds the app's .env files only. Throws when the file is not where OpenNext
 * is expected to write it: a build that cannot be checked must not be
 * deployed.
 */
export async function keepAppEnvOnly(appDir, extractProjectEnvVars) {
    const file = path.join(appDir, ".open-next", "cloudflare", "next-env.mjs");
    if (!fs.existsSync(file)) {
        throw new Error(
            `${file} is missing, so the .env values built into the Worker cannot be ` +
                `limited to this app's. OpenNext may have moved it; update scripts/opennext.mjs.`,
        );
    }
    extractProjectEnvVars ??= await loadOpenNextEnvReader();
    // Passing the app as its own root is what makes OpenNext skip the
    // repository's files. The format matches its compileEnvFiles.
    const content = ["production", "development", "test"]
        .map((mode) => {
            const vars = extractProjectEnvVars(mode, { monorepoRoot: appDir, appPath: appDir });
            return `export const ${mode} = ${JSON.stringify(vars)};\n`;
        })
        .join("");
    fs.writeFileSync(file, content);
}

function runCommand(bin, args, cwd) {
    return new Promise((resolve) => {
        const child = spawn(bin, args, {
            cwd,
            stdio: "inherit",
            shell: process.platform === "win32",
        });
        // Ctrl-C reaches the child through the terminal. Forward the other
        // termination signals, which are sent to this process alone.
        const forward = (signal) => child.kill(signal);
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
        for (const signal of signals) process.on(signal, forward);
        const done = (code, signal) => {
            for (const s of signals) process.off(s, forward);
            resolve({ code, signal });
        };
        child.on("exit", done);
        child.on("error", (error) => {
            console.error(`[opennext] could not start ${bin}: ${error.message}`);
            done(1, null);
        });
    });
}

export async function main({
    commands = process.argv.slice(2),
    appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    bin = "opennextjs-cloudflare",
} = {}) {
    if (commands.length === 0) {
        console.error("Usage: node scripts/opennext.mjs <command> [command...]");
        return 2;
    }
    const repoLockfile = path.join(appDir, "..", "package-lock.json");
    if (!fs.existsSync(repoLockfile)) {
        console.error(
            `[opennext] ${repoLockfile} is missing; OpenNext needs it to find the repository root.`,
        );
        return 1;
    }
    recoverLockfiles(appDir);
    const restore = hideLockfiles(appDir);
    try {
        for (const command of commands) {
            const { code, signal } = await runCommand(bin, [command], appDir);
            if (signal) return 128 + (signalNumbers[signal] ?? 1);
            if (code !== 0) return code ?? 1;
            if (command === "build") await keepAppEnvOnly(appDir);
        }
        return 0;
    } finally {
        restore();
    }
}

const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(
        (code) => process.exit(code),
        (error) => {
            console.error(`[opennext] ${error.message}`);
            process.exit(1);
        },
    );
}
