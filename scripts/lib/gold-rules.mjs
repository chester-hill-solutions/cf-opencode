import { structuralRules } from './structural-rules.mjs';
import { asyncWaterfalls } from '../../tools/vendor/callcaster-guards/async-waterfalls.mjs';
import { lifecycleWrites } from '../../tools/vendor/callcaster-guards/state-machine-analysis.mjs';
import { effectCalls, isEffectCompliant, effectDependencyViolations } from '../../tools/vendor/callcaster-guards/effects-lib.mjs';

function effectFindings(source, file) {
  return effectCalls(source, file).flatMap((call) => {
    const before = source.slice(0, call.offset);
    const end = before.lastIndexOf('*/');
    const start = before.lastIndexOf('/**', end);
    const adjacent = before.slice(end + 2).replace(/^[ \t]*\/\/[^\n]*$/gm, '').trim() === '';
    const block = start >= 0 && end >= start && adjacent ? before.slice(start + 3, end) : '';
    const tags = Object.fromEntries([...block.matchAll(/(@effect(?:-[\w-]+)?)\s+([^\n]*)/g)]
      .map(([, name, value]) => [name, value.trim()]));
    const issues = isEffectCompliant(tags)
      ? effectDependencyViolations(call, tags['@effect-deps'])
      : ['document @effect, @effect-deps, @effect-side-effects and @effect-why-not-loader'];
    return issues.map((detail) => ({ ...call, rule: 'effect-contract', detail }));
  });
}

function scannerRule(scan, describe) {
  return {
    meta: { type: 'suggestion', schema: [], messages: { finding: '{{detail}}' } },
    create(context) {
      return { Program() {
        const source = context.sourceCode.text;
        for (const finding of scan(source, context.filename)) {
          context.report({ loc: { line: finding.line, column: 0 }, messageId: 'finding',
            data: { detail: `${finding.symbol}: ${describe(finding)}` } });
        }
      } };
    },
  };
}

export const goldPlugin = { rules: {
  ...structuralRules,
  'async-sequencing': scannerRule(asyncWaterfalls, (f) => `${f.rule}; review dependencies and ordering before parallelising`),
  'lifecycle-state': scannerRule(lifecycleWrites, (f) => `${f.rule} ${f.target}=${JSON.stringify(f.value)}; use an explicit event reducer or transition table`),
  'effect-contract': scannerRule(effectFindings, (f) => f.detail),
} };
export { effectFindings };
