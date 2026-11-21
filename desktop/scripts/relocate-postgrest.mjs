// Run before packaging/signing, including when native binaries were cached.
// Developer ID signing later replaces this development ad-hoc signature.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const original = '/opt/homebrew/opt/libpq/lib/libpq.5.dylib';
const bundled = '@loader_path/pg/lib/libpq.5.dylib';
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' });

/**
 * Read unique dependency load paths from a Mach-O file, excluding its dylib ID.
 * @param {string} file Path to the native binary or library to inspect.
 * @returns {string[]} Load paths reported by otool.
 * @throws {Error} If otool cannot inspect the file.
 */
export function dependencies(file) {
  // Read load commands, not otool -L's dylib ID (which is not a dependency).
  const commands = run('/usr/bin/otool', ['-l', file]).split(/\nLoad command \d+\n/);
  return [...new Set(commands.filter(c => /\bcmd LC_(?:LOAD_DYLIB|LOAD_WEAK_DYLIB|REEXPORT_DYLIB|LOAD_UPWARD_DYLIB)\b/.test(c))
    .map(c => c.match(/\n\s+name (.+) \(offset \d+\)/)?.[1]).filter(Boolean))];
}

/**
 * Audit PostgREST's transitive dependencies without modifying the bundle.
 * @param {string} bin Native bin directory containing postgrest and pg/lib.
 * @returns {string[]} Canonical paths of the bundled Mach-O dependency closure.
 * @throws {Error} If a non-system dependency is missing, non-relocatable or
 * resolves outside bin, or a native inspection command fails.
 */
export function auditDependencies(bin) {
  const root = realpathSync(bin);
  const visited = new Set();
  /** Follow one bundled dependency, rejecting escapes and avoiding cycles. */
  function visit(file) {
    file = realpathSync(file);
    if (!file.startsWith(root + path.sep)) throw new Error(`Dependency escapes bundle: ${file}`);
    if (visited.has(file)) return;
    visited.add(file);
    for (const dep of dependencies(file)) {
      if (dep.startsWith('/usr/lib/') || dep.startsWith('/System/Library/')) continue;
      if (!dep.startsWith('@loader_path/')) throw new Error(`Non-relocatable dependency in ${file}: ${dep}`);
      visit(path.resolve(path.dirname(file), dep.slice('@loader_path/'.length)));
    }
  }
  visit(path.join(root, 'postgrest'));
  return [...visited];
}

/**
 * Relocate the pinned PostgREST libpq load path in a pre-signing build cache.
 * Audit the closure before repairing an ad-hoc signature; keep valid signatures.
 * Never use this helper on an installed or release-signed application.
 * @param {string} bin Native bin directory containing postgrest and pg/lib.
 * @returns {string[]} Canonical paths verified by the dependency audit.
 * @throws {Error} If linkage is unexpected, dependencies fail the audit, or a
 * native edit/signature command fails. A failed run may leave the cache edited.
 */
export function relocatePostgrest(bin) {
  const file = path.resolve(bin, 'postgrest');
  const deps = dependencies(file);
  const changed = deps.includes(original);
  if (deps.includes(original)) {
    // Resolve the target first so a missing bundled libpq never leaves a
    // partially repaired binary. install_name_tool invalidates its signature.
    realpathSync(path.join(bin, 'pg/lib/libpq.5.dylib'));
    run('/usr/bin/install_name_tool', ['-change', original, bundled, file]);
  } else if (!deps.includes(bundled)) {
    throw new Error('Unexpected PostgREST libpq linkage; inspect the pinned release before packaging');
  }
  // This is a pre-signing build cache, not an installed release. A prior run
  // may have stopped after rewriting the load command but before signing.
  // Audit first: never sign a cache with unexpected or escaping dependencies.
  const files = auditDependencies(bin);
  if (changed) run('/usr/bin/codesign', ['--force', '--sign', '-', file]);
  try {
    run('/usr/bin/codesign', ['--verify', '--strict', file]);
  } catch (error) {
    // Only recover codesign's validation failure, not tool execution errors.
    if (error.status !== 1) throw error;
    run('/usr/bin/codesign', ['--force', '--sign', '-', file]);
    run('/usr/bin/codesign', ['--verify', '--strict', file]);
  }
  console.log(`Verified relocatable PostgREST dependency closure (${files.length} bundled Mach-O files)`);
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  relocatePostgrest(process.argv[2] || fileURLToPath(new URL('../local-stack/bin', import.meta.url)));
}
