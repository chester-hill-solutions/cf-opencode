import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const name of ['duplication', 'builtAssets', 'config', 'telemetry', 'identities', 'async',
  'states', 'effects', 'suppressed', 'structural', 'bundle', 'counts', 'history', 'fileSize', 'strictTypes']) {
  test(`gold quality: ${name} rejects faults and permits controls`, async () => {
    const child = Bun.spawn(['node', 'tests/fixtures/gold-quality.mjs', name], {
      cwd: root, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  }, 60_000);
}

test('CI runs the same aggregate gate as local checks with trusted history', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(workflow).toContain('run: bun run ci:local');
  expect(workflow).toContain('fetch-depth: 0');
  expect(workflow).toContain('github.event.pull_request.base.sha');
  for (const command of ['typecheck', 'build:ui', 'check:quality', 'check:client-bundle', 'test', 'test:workers']) {
    expect(manifest.scripts['ci:local']).toContain(`bun run ${command}`);
  }
  expect(manifest.scripts['ci:local'].indexOf('build:ui')).toBeLessThan(manifest.scripts['ci:local'].indexOf('check:client-bundle'));
});
