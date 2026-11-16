import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { priorFile } from './quality-history.mjs';

export function validateCounts(value) {
  if (!value || value.version !== 1 || !value.counts || Array.isArray(value.counts) || typeof value.counts !== 'object') {
    throw new Error('Invalid count baseline');
  }
  for (const [key, count] of Object.entries(value.counts)) {
    if (!key || !Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid count for ${key}`);
  }
  return value.counts;
}
export function compareCounts(current, allowed, previous) {
  const increases = (a, b) => Object.entries(a).filter(([key, count]) => count > (b[key] ?? 0));
  const added = increases(current, allowed);
  const stale = increases(allowed, current);
  const growth = previous ? increases(allowed, previous) : [];
  return { ok: !added.length && !stale.length && !growth.length, added, stale, growth };
}
export function checkCounts({ root = process.cwd(), file, counts, update = false }) {
  const allowed = validateCounts(JSON.parse(readFileSync(resolve(root, file), 'utf8')));
  const prior = priorFile(root, file);
  const result = compareCounts(counts, allowed, prior ? validateCounts(prior) : undefined);
  if (result.added.length || result.growth.length || (!update && result.stale.length)) {
    throw new Error(`${file}: current vs allowed: ${JSON.stringify({ added: result.added.map(([key, current]) => ({ key, current, allowed: allowed[key] ?? 0 })), stale: result.stale, growth: result.growth })}. Fix new debt; stale allowances require the tools:*:baseline command. Never raise a baseline.`);
  }
  if (update) writeFileSync(resolve(root, file), `${JSON.stringify({ version: 1, counts }, null, 2)}\n`);
  return result;
}
