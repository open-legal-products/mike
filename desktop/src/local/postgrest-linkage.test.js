const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cpSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, renameSync,
  rmSync, readFileSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Input is fetched/staged/packaged output, already relocated by the build.
// Audit it in place before any mutable-copy regression can repair a defect.
const nativeOptions = { skip: process.platform !== 'darwin' || !process.env.MIKE_NATIVE_BIN };
const original = '/opt/homebrew/opt/libpq/lib/libpq.5.dylib';
const bundled = '@loader_path/pg/lib/libpq.5.dylib';

/** Copy a Postgres test fixture without redirecting its relative symlinks. */
function copyPostgresBundle(source, destination) {
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

test('Postgres test copy preserves relative links after moving without its source', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'mike-linkage-copy-'));
  try {
    const source = path.join(temp, 'source/pg');
    const copy = path.join(temp, 'copy/pg');
    mkdirSync(path.join(source, 'lib'), { recursive: true });
    writeFileSync(path.join(source, 'lib/libpq.5.dylib'), 'synthetic library');
    symlinkSync('libpq.5.dylib', path.join(source, 'lib/libpq.dylib'));
    copyPostgresBundle(source, copy);
    rmSync(path.join(temp, 'source'), { recursive: true, force: true });
    renameSync(path.join(temp, 'copy'), path.join(temp, 'Moved package with spaces'));
    const moved = path.join(temp, 'Moved package with spaces/pg');
    const link = path.join(moved, 'lib/libpq.dylib');
    assert.equal(readlinkSync(link), 'libpq.5.dylib');
    assert.equal(realpathSync(link), path.join(realpathSync(moved), 'lib/libpq.5.dylib'));
    assert.equal(readFileSync(link, 'utf8'), 'synthetic library');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('actual PostgREST input has only bundled dependencies', nativeOptions, async () => {
  const { auditDependencies, dependencies } = await import('../../scripts/relocate-postgrest.mjs');
  const bin = process.env.MIKE_NATIVE_BIN;
  assert.ok(auditDependencies(bin).length > 1);
  assert.ok(dependencies(path.join(bin, 'postgrest')).includes(bundled));
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', path.join(bin, 'postgrest')]);
});

test('PostgREST uses only bundled libraries after moving the package', nativeOptions, async () => {
  const { relocatePostgrest, auditDependencies, dependencies } = await import('../../scripts/relocate-postgrest.mjs');
  // Do not let relocation of the test copy hide broken build output.
  auditDependencies(process.env.MIKE_NATIVE_BIN);
  const temp = mkdtempSync(path.join(tmpdir(), 'mike-linkage-'));
  try {
    const bin = path.join(temp, 'original/bin');
    copyPostgresBundle(process.env.MIKE_NATIVE_BIN + '/pg', bin + '/pg');
    cpSync(process.env.MIKE_NATIVE_BIN + '/postgrest', bin + '/postgrest');
    // Recreate the pinned upstream load command even from already-relocated
    // fetched input, so CI always exercises the repair and rejection paths.
    execFileSync('/usr/bin/install_name_tool', ['-change', bundled, original, bin + '/postgrest']);
    assert.ok(dependencies(bin + '/postgrest').includes(original));
    assert.throws(() => auditDependencies(bin), /Non-relocatable dependency/);
    const initial = readFileSync(bin + '/postgrest');
    relocatePostgrest(bin);
    const repaired = readFileSync(bin + '/postgrest');
    relocatePostgrest(bin);
    assert.ok(readFileSync(bin + '/postgrest').equals(repaired), 'valid signature is preserved');
    // Simulate a cache interrupted after rewriting the stock load command.
    writeFileSync(bin + '/postgrest', initial);
    execFileSync('/usr/bin/install_name_tool', ['-change', original, bundled, bin + '/postgrest']);
    // Some Apple toolchains refresh ad-hoc signatures during load-command
    // edits. Explicitly remove it to model a failed/interrupted signing step.
    execFileSync('/usr/bin/codesign', ['--remove-signature', bin + '/postgrest']);
    assert.throws(() => execFileSync('/usr/bin/codesign', ['--verify', '--strict', bin + '/postgrest']));
    assert.ok(dependencies(bin + '/postgrest').includes('@loader_path/pg/lib/libpq.5.dylib'));
    relocatePostgrest(bin);
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', bin + '/postgrest']);
    const recovered = readFileSync(bin + '/postgrest');
    relocatePostgrest(bin);
    assert.ok(readFileSync(bin + '/postgrest').equals(recovered), 'recovered signature is preserved');

    // Invalid signatures do not authorize re-signing unaudited dependencies.
    execFileSync('/usr/bin/install_name_tool', ['-change', '/usr/lib/libz.1.dylib',
      '/opt/homebrew/lib/libz.1.dylib', bin + '/postgrest']);
    const invalid = readFileSync(bin + '/postgrest');
    assert.throws(() => relocatePostgrest(bin), /Non-relocatable dependency/);
    assert.ok(readFileSync(bin + '/postgrest').equals(invalid), 'unsafe cache is not re-signed');
    writeFileSync(bin + '/postgrest', repaired);
    relocatePostgrest(bin);
    assert.ok(readFileSync(bin + '/postgrest').equals(repaired), 'repair is idempotent');
    renameSync(path.join(temp, 'original'), path.join(temp, 'Moved package with spaces'));
    const moved = path.join(temp, 'Moved package with spaces/bin');
    assert.ok(auditDependencies(moved).length > 1);
    const version = execFileSync(moved + '/postgrest', ['--version'], {
      env: {}, cwd: '/', encoding: 'utf8', timeout: 15000,
    });
    assert.match(version, /PostgREST 14\.12/);
    console.log(version.trim());
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
