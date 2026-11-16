import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

/** ESLint does not hash local plugin implementations; include them to avoid stale guard results. */
export function eslintFor(root = process.cwd()) {
  const hash = createHash('sha256');
  const files = ['eslint.config.mjs', 'bun.lock', 'scripts/lib/gold-rules.mjs', 'scripts/lib/structural-rules.mjs',
    ...readdirSync(resolve(root, 'tools/vendor/callcaster-guards')).filter((name) => name.endsWith('.mjs')).sort().map((name) => `tools/vendor/callcaster-guards/${name}`)];
  for (const file of files) hash.update(file).update(readFileSync(resolve(root, file)));
  return new ESLint({ cwd: root, cache: true, cacheStrategy: 'content',
    cacheLocation: resolve(root, `node_modules/.cache/eslint-gold-${hash.digest('hex').slice(0, 16)}`),
    overrideConfigFile: resolve(root, 'eslint.config.mjs') });
}
