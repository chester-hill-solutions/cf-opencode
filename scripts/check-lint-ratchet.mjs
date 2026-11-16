/** Aboiteau gold policy, using Ratchetstrap's identity adapter. Suppressed debt still counts. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eslintFor } from './lib/eslint-runner.mjs';
import { parseIdentityBaseline, summarizeIdentities, evaluateIdentities, tightenIdentities } from '@chester-hill-solutions/ratchet-strap';
import { priorFile } from './lib/quality-history.mjs';

export const baselineFile = 'scripts/baselines/lint-ratchet.json';

/** The rules ESLint actually reported, whether or not the diagnostic is suppressed. */
function reportedRules(reports) {
  const rules = new Set();
  for (const report of reports) {
    for (const message of [...report.messages, ...report.suppressedMessages]) {
      if (message.ruleId) rules.add(message.ruleId);
    }
  }
  return [...rules].sort();
}

/**
 * A first adoption has no predecessor to tighten against, so its baseline is
 * written straight from the observation. Every later run ratchets normally.
 */
function seedBaseline(rules) {
  if (!rules.length) {
    throw new Error('No lint diagnostics to adopt; declare the tracked rules explicitly with ratchet-strap init.');
  }
  return { schemaVersion: 2, mode: 'identities', adapter: 'eslint-identities@1',
    identities: Object.fromEntries(rules.map((rule) => [rule, []])) };
}

export async function checkLint({ root = process.cwd(), previous, update = false } = {}) {
  const eslint = eslintFor(root);
  const reports = await eslint.lintFiles(['.']);
  const path = resolve(root, baselineFile);
  const firstAdoption = !existsSync(path);
  if (firstAdoption && !update) {
    throw new Error(`${baselineFile} is missing; adopt it once with bun run tools:lint-ratchet:baseline.`);
  }
  const baseline = parseIdentityBaseline(
    firstAdoption
      ? seedBaseline(reportedRules(reports))
      : JSON.parse(readFileSync(path, 'utf8')),
  );
  // Track every enabled warning/error, including rules added later; no new rule can silently escape.
  const configured = new Set(Object.keys(baseline.identities));
  for (const report of reports) {
    for (const message of [...report.messages, ...report.suppressedMessages]) {
      if (message.ruleId && !configured.has(message.ruleId)) {
        baseline.identities[message.ruleId] = [];
        configured.add(message.ruleId);
      }
    }
  }
  const trusted = previous ?? priorFile(root, baselineFile);
  // Legacy counts are all zero. They remain a constraint during the first identity adoption.
  if (trusted && trusted.schemaVersion !== 2) {
    for (const [rule, count] of Object.entries(trusted).filter(([rule]) => !rule.startsWith('_'))) {
      if (count !== 0 || !Object.hasOwn(baseline.identities, rule) || baseline.identities[rule].length !== 0) {
        throw new Error(`Cannot adopt identities by raising legacy rule ${rule}; fix the code.`);
      }
    }
  }
  const observation = summarizeIdentities(reports, [...configured], { adapter: baseline.adapter, root });
  const result = evaluateIdentities(baseline, observation, trusted?.schemaVersion === 2 ? trusted : undefined);
  if (update) {
    const next = firstAdoption
      ? { ...baseline, identities: observation.identities }
      : tightenIdentities(baseline, observation, trusted?.schemaVersion === 2 ? trusted : undefined);
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { ...result, lint: (await eslint.loadFormatter('stylish')).format(reports) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const update = process.argv.includes('--baseline');
    const result = await checkLint({ update });
    if (!result.ok && !update) {
      process.stderr.write(result.lint);
      process.stderr.write(`${JSON.stringify({ added: result.added, stale: result.stale, baselineGrowth: result.baselineGrowth }, null, 2)}\n`);
      process.stderr.write('check:lint-ratchet failed. Fix the reported rule; repair stale allowances with bun run tools:lint-ratchet:baseline. Baselines cannot grow.\n');
      process.exitCode = 1;
    } else process.stdout.write(`check:lint-ratchet: ${result.files} files, ${Object.values(result.counts).reduce((a, b) => a + b, 0)} existing identities; no new debt.\n`);
  } catch (error) {
    process.stderr.write(`check:lint-ratchet failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
