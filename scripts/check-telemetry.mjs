/**
 * Telemetry adoption **report**, not a gate.
 *
 * The vendored analyser counts every async function as an unobserved boundary
 * unless it calls an `@opentelemetry/*` signal. This repository traces through
 * `cloudflare:workers` `tracing`, so no application code is "covered" and the
 * count is effectively a census of async functions. Blocking on that would
 * forbid the helper extraction the lint ratchet requires, so coverage is
 * advisory: it is reported for reviewers and never fails the build.
 *
 * One rule stays hard: no Sentry dependency or reference. That is a vendor
 * policy, not telemetry coverage.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectTelemetryDebt } from '../tools/vendor/callcaster-guards/telemetry-source.mjs';
import { productionRoots, upstreamUI } from './lib/quality-files.mjs';
import { compareCounts, validateCounts } from './lib/count-ratchet.mjs';

const baselineFile = 'scripts/baselines/telemetry.json';

try {
  const { hits, files, allowed } = collectTelemetryDebt(process.cwd(), {
    sourceRoots: productionRoots,
    // Third-party UI is maintained upstream; local fixture bootstrapping has no production lifecycle.
    skipPaths: [upstreamUI],
  });
  if (!files) throw new Error('Empty telemetry scan');
  if (process.argv.includes('--update')) {
    writeFileSync(resolve(process.cwd(), baselineFile), `${JSON.stringify({ version: 1, counts: allowed }, null, 2)}\n`);
  }

  const sentry = hits.filter((hit) => hit.key.includes('::sentry.'));
  if (sentry.length) {
    console.error(`check:telemetry failed: ${sentry.length} Sentry reference(s) or dependency(ies).`);
    for (const hit of sentry) console.error(`  ${hit.file}:${hit.line} ${hit.key}`);
    process.exitCode = 1;
  } else {
    const counts = {};
    for (const hit of hits) counts[hit.key] = (counts[hit.key] ?? 0) + 1;
    const asyncCount = Object.keys(counts).filter((key) => key.endsWith('::otel.async')).length;
    let delta = 'baseline unavailable';
    try {
      const baseline = validateCounts(JSON.parse(readFileSync(resolve(process.cwd(), baselineFile), 'utf8')));
      const { added, stale } = compareCounts(counts, baseline);
      delta = `${added.length} new, ${stale.length} stale vs baseline`;
    } catch {
      // A report must not fail because its baseline moved.
    }
    console.log(`check:telemetry (advisory): ${files} source files, ${Object.keys(counts).length} identities (${asyncCount} async); ${delta}. Coverage does not block CI; Sentry does.`);
  }
} catch (error) {
  console.error(`check:telemetry failed: ${error.message}`);
  process.exitCode = 1;
}
