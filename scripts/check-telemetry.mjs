/** Static adoption check from Callcaster; does not install/export telemetry or emit per-render spans. */
import { collectTelemetryDebt } from '../tools/vendor/callcaster-guards/telemetry-source.mjs';
import { productionRoots, upstreamUI } from './lib/quality-files.mjs';
import { checkCounts } from './lib/count-ratchet.mjs';

try {
  const { allowed, files } = collectTelemetryDebt(process.cwd(), {
    sourceRoots: productionRoots,
    // Third-party UI is maintained upstream; local fixture bootstrapping has no production lifecycle.
    skipPaths: [upstreamUI],
  });
  if (!files) throw new Error('Empty telemetry scan');
  checkCounts({ file: 'scripts/baselines/telemetry.json', counts: allowed, update: process.argv.includes('--update') });
  console.log(`check:telemetry: ${files} source files, no new unobserved boundaries or Sentry usage.`);
} catch (error) {
  console.error(`check:telemetry failed: ${error.message}\nDetails: bun run check:telemetry. Repair: bun run tools:telemetry:baseline after adding real OTel coverage.`);
  process.exitCode = 1;
}
