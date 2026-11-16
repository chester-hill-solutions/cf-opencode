/** Independent clone and duplicated-line ceilings, at Callcaster's current 40/50-token thresholds. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { productionRoots, upstreamUI } from './lib/quality-files.mjs';
import { checkCounts } from './lib/count-ratchet.mjs';

export function duplicationCounts(root = process.cwd()) {
  const counts = {};
  const output = mkdtempSync(join(tmpdir(), 'aboiteau-dry-'));
  try {
    for (const tokens of [40, 50]) {
      const dir = join(output, String(tokens));
      const result = spawnSync(process.execPath, [resolve(root, 'node_modules/jscpd/run-jscpd.js'),
        ...productionRoots, '--min-tokens', String(tokens), '--reporters', 'json', '--output', dir,
        '--ignore', `${upstreamUI}/**,**/*.d.ts,**/*.test.ts,**/node_modules/**`, '--silent'], { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`jscpd failed (${result.status}): ${result.stderr}`);
      // A fresh per-run directory prevents a failed scan from reusing yesterday's report.
      const total = JSON.parse(readFileSync(join(dir, 'jscpd-report.json'), 'utf8')).statistics.total;
      if (!total.sources) throw new Error('Empty duplication scan');
      for (const key of ['clones', 'duplicatedLines']) {
        if (!Number.isSafeInteger(total[key]) || total[key] < 0) throw new Error(`Invalid jscpd ${key}`);
        counts[`${tokens}/${key}`] = total[key];
      }
    }
    return counts;
  } finally { rmSync(output, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const counts = duplicationCounts();
    checkCounts({ file: 'scripts/baselines/duplication.json', counts, update: process.argv.includes('--update') });
    console.log(`check:dry passed: ${JSON.stringify(counts)}. Details: bun run check:dry; after repairs bun run tools:dry:baseline.`);
  } catch (error) {
    console.error(`check:dry failed: ${error.message}`);
    process.exitCode = 1;
  }
}
