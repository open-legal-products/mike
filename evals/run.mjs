#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { compare, gradeCase, invariant, jsonl, score, suiteHash, validateSuite } from './lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const command = args.shift();
const options = {};
try {
  invariant(['validate', 'smoke', 'score', 'compare'].includes(command),
    'Usage: node evals/run.mjs validate|smoke|score --responses FILE|compare --baseline FILE --candidate FILE [--axis model|system] [--out FILE]');
  const allowed = { validate: [], smoke: [], score: ['responses', 'out'], compare: ['baseline', 'candidate', 'axis', 'out'] }[command];
  while (args.length) {
    const flag = args.shift();
    invariant(flag.startsWith('--') && allowed.includes(flag.slice(2)) && args.length && !args[0].startsWith('--')
      && !Object.hasOwn(options, flag.slice(2)), `Invalid option: ${flag}`);
    options[flag.slice(2)] = args.shift();
  }
  const workflows = JSON.parse(await readFile(resolve(root, 'evals/workflows.json'), 'utf8'));
  const cases = await jsonl(resolve(root, 'evals/cases/seed.jsonl'));
  const validation = await validateSuite(workflows, cases, root);
  const suite = { workflows, cases, hash: suiteHash(workflows, cases) };
  const capture = async name => {
    invariant(options[name], `--${name} FILE is required`);
    return JSON.parse(await readFile(resolve(options[name]), 'utf8'));
  };
  let result;
  if (command === 'validate') result = validation;
  if (command === 'smoke') {
    const checks = cases.map(item => gradeCase(item, { status: 'completed', output: item.reference_output, judgments: [] }));
    invariant(checks.every(check => check.deterministic_pass && !check.passed), 'Reference contract smoke failed');
    result = { kind: 'reference_contract_smoke', ...validation, deterministic_contracts_passed: checks.length,
      model_or_product_evaluated: false, legal_quality_evaluated: false, decision_eligible: false };
  }
  if (command === 'score') result = score(await capture('responses'), suite);
  if (command === 'compare') result = compare(await capture('baseline'), await capture('candidate'), suite, options.axis ?? 'model');
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) await writeFile(resolve(options.out), serialized, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(serialized);
} catch (error) {
  process.stderr.write(`Eval error: ${error.message}\n`);
  process.exitCode = 1;
}
