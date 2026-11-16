import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const productionRoots = ['src', 'web', 'runtime/opencode', 'packages/ui/src'];
export const upstreamUI = 'packages/ui/src/components/ui';
export function qualityFiles(root, roots = [...productionRoots, 'scripts', 'tests', 'test', 'bench']) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = relative(root, path);
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' ||
          name === upstreamUI || name === 'bench/comparison/baseline') continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:[cm]?js|tsx?)$/.test(name) && !name.endsWith('.d.ts')) files.push(path);
    }
  }
  for (const dir of roots) walk(join(root, dir));
  return files.sort();
}

export function fileSizeCounts(root) {
  return Object.fromEntries(qualityFiles(root).flatMap((path) => {
    const lines = readFileSync(path, 'utf8').split('\n').length;
    return lines > 800 ? [[relative(root, path), lines - 800]] : [];
  }));
}
