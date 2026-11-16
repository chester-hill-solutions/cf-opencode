import ts from 'typescript';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkCounts } from './lib/count-ratchet.mjs';

// Existing projects already use strict:true. Measure the additional gold compiler
// checks separately so adoption preserves behavior while every new diagnostic fails.
export function strictTypeCounts(root = process.cwd(), configs = ['tsconfig.json', 'tsconfig.tests.json', 'tsconfig.worker-tests.json', 'tsconfig.ui.json',
    'scripts/native-storage-qualification/tsconfig.json', 'scripts/provider-egress-qualification/tsconfig.json',
    'runtime/opencode/tsconfig.json']) {
  const counts = {};
  for (const config of configs) {
    const path = resolve(root, config);
    const source = ts.readConfigFile(path, ts.sys.readFile);
    if (source.error) throw new Error(ts.flattenDiagnosticMessageText(source.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(source.config, ts.sys, resolve(path, '..'), {
      strict: true, noImplicitAny: true, noImplicitReturns: true,
      noUncheckedIndexedAccess: true, noImplicitOverride: true, noEmit: true,
    }, path);
    if (parsed.errors.length || !parsed.fileNames.length) throw new Error(`Invalid or empty TypeScript project: ${config}`);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      const file = diagnostic.file ? relative(root, diagnostic.file.fileName) : config;
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      const key = `${config}:${file}:TS${diagnostic.code}:${message}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const counts = strictTypeCounts();
    checkCounts({ file: 'scripts/baselines/strict-types.json', counts, update: process.argv.includes('--update') });
    console.log(`check:strict-types: ${Object.values(counts).reduce((a, b) => a + b, 0)} existing gold compiler diagnostics; no new debt.`);
  } catch (error) {
    console.error(`check:strict-types failed: ${error.message}\nDetails: bun run check:strict-types. Fix types, then bun run tools:strict-types:baseline.`);
    process.exitCode = 1;
  }
}
