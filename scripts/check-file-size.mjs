import { checkCounts } from './lib/count-ratchet.mjs';
import { fileSizeCounts } from './lib/quality-files.mjs';

try {
  const counts = fileSizeCounts(process.cwd());
  checkCounts({ file: 'scripts/baselines/file-size.json', counts, update: process.argv.includes('--update') });
  console.log(`check:file-size: ${Object.keys(counts).length} existing files over 800 lines; no growth.`);
} catch (error) {
  console.error(`check:file-size failed: ${error.message}\nSplit the reported file; then run bun run tools:file-size:baseline.`);
  process.exitCode = 1;
}
