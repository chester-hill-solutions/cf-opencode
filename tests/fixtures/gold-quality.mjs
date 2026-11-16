import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import { collectTelemetryDebt } from '../../tools/vendor/callcaster-guards/telemetry-source.mjs';
import { summarizeIdentities, evaluateIdentities, tightenIdentities } from '@chester-hill-solutions/ratchet-strap';
import { effectFindings, goldPlugin } from '../../scripts/lib/gold-rules.mjs';
import { asyncWaterfalls } from '../../tools/vendor/callcaster-guards/async-waterfalls.mjs';
import { lifecycleWrites } from '../../tools/vendor/callcaster-guards/state-machine-analysis.mjs';
import { duplicationCounts } from '../../scripts/check-dry.mjs';
import { checkClientBundle, bundleViolations } from '../../scripts/check-client-bundle.mjs';
import { compareCounts } from '../../scripts/lib/count-ratchet.mjs';
import { priorFile } from '../../scripts/lib/quality-history.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { productionRoots, fileSizeCounts } from '../../scripts/lib/quality-files.mjs';
import { strictTypeCounts } from '../../scripts/check-strict-types.mjs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const fixture = (run) => {
  const root = mkdtempSync(join(tmpdir(), 'aboiteau-gold-'));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const observation = (messages) => summarizeIdentities([{ filePath: `${process.cwd()}/src/a.ts`, messages, suppressedMessages: [] }], ['no-console'], { adapter: 'eslint-identities@1', root: process.cwd() });
const baseline = (observed) => ({ schemaVersion: 2, mode: 'identities', adapter: 'eslint-identities@1', identities: observed.identities });
const diagnostic = (message, line = 1) => ({ ruleId: 'no-console', severity: 1, message, line, column: 0 });
const cases = {
  async config() {
    const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
    const config = await eslint.calculateConfigForFile('web/gold.tsx');
    for (const [rule, max] of Object.entries({ complexity: 10, 'max-depth': 3, 'max-params': 4, 'max-lines-per-function': 80 })) {
      assert.equal(config.rules[rule][1].max, max);
    }
    for (const rule of ['no-console', 'gold/async-sequencing', 'gold/effect-contract', 'gold/lifecycle-state', 'react-hooks/exhaustive-deps']) assert.equal(config.rules[rule][0], 1);
    for (const rule of ['react-hooks/rules-of-hooks','gold/body-once','@typescript-eslint/ban-ts-comment']) assert.equal(config.rules[rule][0], 2);
    const badHook = await eslint.lintText('import {useState} from "react";export function A(){if (Math.random()) useState(1);return null;}', {filePath:'web/gold-fixture.tsx'});
    assert.ok(badHook[0].messages.some(m=>m.ruleId==='react-hooks/rules-of-hooks'));
    const badType = await eslint.lintText('// @ts-nocheck\nexport const a = 1;', {filePath:'src/gold-fixture.ts'});
    assert.ok(badType[0].messages.some(m=>m.ruleId==='@typescript-eslint/ban-ts-comment'));
    const badA11y = await eslint.lintText('export function A(){return <img src="photo.png"/>}', {filePath:'web/gold-fixture.tsx'});
    assert.ok(badA11y[0].messages.some(m=>m.ruleId==='jsx-a11y/alt-text'));
  },
  telemetry() {
    fixture(root => {
      mkdirSync(join(root,'app'),{recursive:true});
      writeFileSync(join(root,'package.json'),'{"type":"module"}');
      const file=join(root,'app/a.tsx');
      writeFileSync(file,'export function A(){return null;}');
      const first=collectTelemetryDebt(root).allowed;
      assert.ok(Object.keys(first).some(k=>k.includes('otel.component')));
      writeFileSync(file,'export function A(){return null;} export function B(){return null;}');
      assert.equal(compareCounts(collectTelemetryDebt(root).allowed,first).ok,false);
      writeFileSync(file,'// Sentry.captureException(error)\nconst description="Sentry";');
      assert.equal(Object.keys(collectTelemetryDebt(root).allowed).length,0);
      writeFileSync(file,'import * as Sentry from "@sentry/node";Sentry.captureException(new Error());');
      assert.ok(Object.keys(collectTelemetryDebt(root).allowed).some(k=>k.includes('sentry.')));
      mkdirSync(join(root,'node_modules/@opentelemetry/api'),{recursive:true});
      writeFileSync(join(root,'node_modules/@opentelemetry/api/package.json'),'{"name":"@opentelemetry/api","types":"index.d.ts"}');
      writeFileSync(join(root,'node_modules/@opentelemetry/api/index.d.ts'),'export declare const tracer:{startSpan(name:string):void}');
      writeFileSync(file,'import {tracer} from "@opentelemetry/api";export async function run(){tracer.startSpan("operation");}');
      assert.equal(Object.keys(collectTelemetryDebt(root).allowed).length,0);
      writeFileSync(file,'import {tracer} from "@opentelemetry/api";export async function run(){}');
      assert.ok(Object.keys(collectTelemetryDebt(root).allowed).some(k=>k.includes('otel.async')));
    });
  },
  identities() {
    const old = observation([diagnostic('old')]);
    const replacement = observation([diagnostic('new')]);
    assert.equal(evaluateIdentities(baseline(old), replacement).ok, false);
    assert.equal(evaluateIdentities(baseline(old), observation([diagnostic('old', 40)])).ok, true);
    assert.equal(evaluateIdentities(baseline(old), observation([])).ok, false);
    assert.deepEqual(tightenIdentities(baseline(old), observation([])).identities['no-console'], []);
    assert.equal(evaluateIdentities(baseline(replacement), replacement, baseline(old)).ok, false);
    assert.throws(() => tightenIdentities(baseline(old), replacement));
  },
  async() {
    assert.equal(asyncWaterfalls('async function f(){const a=await one();const b=await two();}', 'a.ts').length, 1);
    assert.equal(asyncWaterfalls('async function f(){const a=await one();const b=await two(a);}', 'a.ts').length, 0);
    assert.equal(asyncWaterfalls('async function f(){for(const a of xs){await one(a)}}', 'a.ts')[0]?.rule, 'await-in-loop');
    assert.equal(asyncWaterfalls('async function f(){const [a,b]=await Promise.all([one(),two()])}', 'a.ts').length, 0);
  },
  states() {
    const bad = 'import {useState} from "react";function A(){const [state,setState]=useState("idle");setState("ready");}';
    assert.equal(lifecycleWrites(bad, 'a.tsx').length, 2);
    assert.equal(lifecycleWrites('const state=reduce(current,event);db.update({status:state});', 'a.ts').length, 0);
    assert.equal(lifecycleWrites('response.status=200;', 'a.ts').length, 0);
  },
  effects() {
    assert.equal(effectFindings('function A(){useEffect(()=>{},[])}', 'a.tsx').length, 1);
    const compliant = '/**\n * @effect listen for scanner events\n * @effect-deps [scanner]\n * @effect-side-effects dom\n * @effect-why-not-loader browser device lifecycle\n */\nuseEffect(()=>{},[scanner]);';
    assert.equal(effectFindings(compliant, 'a.tsx').length, 0);
    assert.equal(effectFindings(compliant.replace('[scanner]);', '[other]);'), 'a.tsx').length, 2);
    assert.equal(effectFindings(compliant.replace('*/\nuseEffect', '*/\nconst unrelated=1;\nuseEffect'), 'a.tsx').length, 1);
  },
  async suppressed() {
    const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
    const reports = await eslint.lintText('// eslint-disable-next-line no-console\nconsole.log("debt");', { filePath: 'src/gold-fixture.ts' });
    const observed = summarizeIdentities(reports, ['no-console'], { adapter: 'eslint-identities@1', root: process.cwd() });
    assert.equal(observed.counts['no-console'], 1);
    assert.equal(evaluateIdentities(baseline(observation([])), observed).ok, false);
  },
  async structural() {
    const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ plugins: { gold: goldPlugin }, rules: { 'gold/body-once': 'error', 'gold/mock-passthrough': 'error' } }] });
    const rules = async (text) => (await eslint.lintText(text))[0].messages.map((m) => m.ruleId);
    assert.deepEqual(await rules('async function f(request){await request.json();await request.text()}'), ['gold/body-once']);
    assert.deepEqual(await rules('function f(){Response.json({});Response.json({})}'), []);
    assert.deepEqual(await rules('async function f(request){if(x){return request.text()}return request.json()}'), []);
    assert.deepEqual(await rules('async function f(request){if(x){await request.text()}else{await request.json()}}'), []);
    assert.deepEqual(await rules('async function f(request){if(x){await request.text();return 1}await request.json()}'), []);
    assert.deepEqual(await rules('async function f(request){if(x){await request.text()}await request.json()}'), ['gold/body-once']);
    assert.deepEqual(await rules('async function f(){if(x){const response=one();await response.json();return 1}const response=two();await response.text()}'), []);
    assert.deepEqual(await rules('mock.module("./server",()=>({onlyOne:1}));'), ['gold/mock-passthrough']);
    assert.deepEqual(await rules('mock.module("./server",()=>({/*importOriginal*/...fake,onlyOne:1}));'), ['gold/mock-passthrough']);
    assert.deepEqual(await rules('vi.mock("./server",async(importOriginal)=>({...await importOriginal(),one:1}));'), []);
    assert.deepEqual(await rules('const actual=await import("./server");mock.module("./server",()=>({...actual,one:1}));'), []);
  },
  bundle() {
    for (const value of ['DATABASE_URL', 'node:fs', '@chester-hill-solutions/eventkit-postgres', 'AUTH_SECRET', 'sk_live_01234567890123456789']) assert.ok(bundleViolations(value).length);
    assert.deepEqual(bundleViolations('const currency="CAD";'), []);
  },
  duplication() {
    fixture(root => {
      symlinkSync(join(process.cwd(),'node_modules'),join(root,'node_modules'),'dir');
      for(const dir of productionRoots) mkdirSync(join(root,dir),{recursive:true});
      const clone = `export function calculate(record) {
        const first = record.primary + record.additional;
        const second = record.secondary * first;
        const total = first + second;
        if (total > record.limit) {
          return { total, first, second, exceeded: true, reference: record.reference };
        }
        return { total, first, second, exceeded: false, reference: record.reference };
      }`;
      writeFileSync(join(root,'src/a.ts'),clone);
      writeFileSync(join(root,'web/b.ts'),'export const unique = 123;');
      const control=duplicationCounts(root);
      writeFileSync(join(root,'web/b.ts'),clone);
      const duplicated=duplicationCounts(root);
      for(const tokens of [40,50]) {
        assert.ok(duplicated[`${tokens}/clones`]>control[`${tokens}/clones`]);
        assert.ok(duplicated[`${tokens}/duplicatedLines`]>control[`${tokens}/duplicatedLines`]);
      }
      assert.equal(compareCounts(duplicated,control).ok,false);
    });
  },
  builtAssets() {
    fixture(root => {
      assert.throws(()=>checkClientBundle(root));
      mkdirSync(join(root,'public/assets'),{recursive:true});
      for (const name of ['settings','onboarding','ui-kit','workspace']) writeFileSync(join(root,`public/assets/${name}.js`),'const eventName="Show";');
      assert.equal(checkClientBundle(root),4);
      writeFileSync(join(root,'public/assets/settings.js'),'const secret=process.env.AUTH_SECRET;');
      assert.throws(()=>checkClientBundle(root),/settings.js: server secret configuration/);
    });
  },
  counts() {
    assert.equal(compareCounts({ clones: 2, lines: 2 }, { clones: 1, lines: 3 }).ok, false);
    assert.equal(compareCounts({ clones: 1 }, { clones: 2 }).ok, false);
    assert.equal(compareCounts({ clones: 2 }, { clones: 2 }, { clones: 1 }).ok, false);
    assert.equal(compareCounts({ clones: 1 }, { clones: 1 }, { clones: 2 }).ok, true);
  },
  history() {
    assert.throws(() => priorFile(process.cwd(), 'x.json', 'definitely-missing-quality-ref'), /trusted quality predecessor/);
    fixture((root) => {
      const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
      git('init', '-q'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture');
      // This repository has its own history, independent of CI's QUALITY_BASE_REF.
      assert.equal(priorFile(root, 'baseline.json', 'HEAD'), undefined);
      writeFileSync(join(root, 'baseline.json'), '{"old":1}'); git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'baseline');
      writeFileSync(join(root, 'baseline.json'), '{"old":2}');
      assert.deepEqual(priorFile(root, 'baseline.json', 'HEAD'), { old: 1 });
    });
  },
  fileSize() {
    fixture(root => {
      for(const dir of [...productionRoots,'scripts','tests','test','bench']) mkdirSync(join(root,dir),{recursive:true});
      const file=join(root,'src/a.ts');
      writeFileSync(file,'// line\n'.repeat(799));
      assert.deepEqual(fileSizeCounts(root),{});
      writeFileSync(file,'// line\n'.repeat(800));
      assert.deepEqual(fileSizeCounts(root),{'src/a.ts':1});
      writeFileSync(file,'// line\n'.repeat(801));
      assert.equal(compareCounts(fileSizeCounts(root),{'src/a.ts':1}).ok,false);
      mkdirSync(join(root,'packages/ui/src/components/ui'),{recursive:true});
      writeFileSync(join(root,'packages/ui/src/components/ui/third-party.ts'),'// line\n'.repeat(900));
      assert.equal(Object.keys(fileSizeCounts(root)).length,1);
    });
  },
  strictTypes() {
    fixture(root => {
      writeFileSync(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',types:[],skipLibCheck:true},include:['sample.ts']}));
      const file=join(root,'sample.ts');
      writeFileSync(file,'export function f(value: string) { return value.length; }');
      assert.deepEqual(strictTypeCounts(root,['tsconfig.json']),{});
      writeFileSync(file,`export function f(value) { if(value) return 1; }
        export const xs: string[] = []; export const first: string = xs[0];
        class Base { run() {} } export class Child extends Base { run() {} }`);
      const counts=strictTypeCounts(root,['tsconfig.json']);
      for(const code of [7006,7030,2322,4114]) assert.ok(Object.keys(counts).some(key=>key.includes(`TS${code}:`)),`missing TS${code}`);
    });
  },
};
if (!cases[process.argv[2]]) throw new Error('Unknown gold fixture');
await cases[process.argv[2]]();
