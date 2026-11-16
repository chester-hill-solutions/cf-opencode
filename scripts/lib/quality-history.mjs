import { spawnSync } from 'node:child_process';

/** Missing history fails closed; only a proven first adoption has no predecessor. */
export function priorFile(root, file, ref = process.env.QUALITY_BASE_REF ?? 'HEAD') {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref)) throw new Error('Invalid QUALITY_BASE_REF');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Cannot read trusted quality predecessor ${ref}; fetch full base history.`);
    return result.stdout;
  };
  git(['cat-file', '-e', `${ref}^{commit}`]);
  if (!git(['ls-tree', '--name-only', ref, '--', file]).trim()) return undefined;
  return JSON.parse(git(['show', `${ref}:${file}`]));
}
