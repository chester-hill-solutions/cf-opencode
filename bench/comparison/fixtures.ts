/** Two authored, dependency-free Git fixtures; no production code or evaluator enters them. */
export const fixtureFiles = {
  ledger: {
    "package.json": JSON.stringify({ name: "ledger-kit-benchmark", private: true, type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
    "src/index.ts": `export function parseLines(text: string): unknown[] {
  return text.split("\\n").filter(Boolean).map((line) => JSON.parse(line))
}
export function parseAmount(value: string): number { return Math.round(Number(value) * 100) }
export interface Entry { id: string; currency: string; cents: number }
export function summarize(rows: Entry[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const row of rows) totals[row.currency] = (totals[row.currency] || 0) + row.cents
  return totals
}
export function mergeLedgers(left: Entry[], right: Entry[]): Entry[] { return [...left, ...right] }
`,
    "src/cli.ts": `import { parseLines, summarize, type Entry } from "./index"
const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error("usage: bun src/cli.ts INPUT OUTPUT")
await Bun.write(output, "")
const rows = parseLines(await Bun.file(input).text()) as Entry[]
await Bun.write(output, JSON.stringify(summarize(rows)) + "\\n")
`,
    "test/basic.test.ts": `import { expect, test } from "bun:test"
import { parseLines, parseAmount, summarize, mergeLedgers } from "../src/index"
test("basic ledger operations", () => {
  expect(parseLines('{"id":"a"}\\n')).toEqual([{id:"a"}])
  expect(parseAmount("12.30")).toBe(1230)
  expect(summarize([{id:"a",currency:"USD",cents:25}])).toEqual({USD:25})
  expect(mergeLedgers([], [{id:"a",currency:"USD",cents:25}])).toHaveLength(1)
})
`,
  },
  queue: {
    "package.json": JSON.stringify({ name: "work-queue-benchmark", private: true, type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
    "src/index.ts": `interface Job { work: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void }
export class WorkQueue {
  private jobs: Job[] = []
  private running = 0
  constructor(private concurrency = 1) {}
  get active(): number { return this.running }
  get pending(): number { return this.jobs.length }
  run<T>(work: () => Promise<T>, _options: { priority?: number; signal?: AbortSignal } = {}): Promise<T> {
    return new Promise((resolve, reject) => { this.jobs.push({ work, resolve: resolve as (value: unknown) => void, reject }); this.drain() })
  }
  private drain(): void {
    while (this.running < this.concurrency && this.jobs.length) {
      const job = this.jobs.shift()!
      this.running++
      Promise.resolve().then(job.work).then((value) => { this.running--; job.resolve(value); this.drain() }, job.reject)
    }
  }
}
`,
    "test/basic.test.ts": `import { expect, test } from "bun:test"
import { WorkQueue } from "../src/index"
test("runs successful tasks", async () => {
  const queue = new WorkQueue(2)
  expect(await Promise.all([queue.run(async()=>1),queue.run(async()=>2)])).toEqual([1,2])
  expect(queue.active).toBe(0)
  expect(queue.pending).toBe(0)
})
`,
  },
} as const

export type FixtureID = keyof typeof fixtureFiles

/** Trusted reference implementations: excluded from agent workspaces and task prompts. */
export const referenceFiles: Record<FixtureID, Record<string, string>> = {
  ledger: {
    "src/index.ts": `export interface Entry { id: string; currency: string; cents: number }
export function parseLines(text: string): unknown[] {
  const rows: unknown[] = []
  for (const [index, raw] of text.replace(/^\\uFEFF/, "").split(/\\r?\\n/).entries()) {
    if (!raw.trim()) continue
    try { rows.push(JSON.parse(raw)) } catch { throw new Error("invalid JSON at line " + (index + 1)) }
  }
  return rows
}
export function parseAmount(value: string): number {
  if (typeof value !== "string" || !/^-?\\d+(?:\\.\\d{1,2})?$/.test(value)) throw new Error("invalid amount")
  const negative = value.startsWith("-")
  const [whole, part = ""] = value.replace(/^-/, "").split(".")
  const result = BigInt(whole!) * 100n + BigInt(part.padEnd(2, "0"))
  const signed = negative ? -result : result
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("amount overflow")
  return Number(signed) || 0
}
export function summarize(rows: Entry[]): Record<string, number> {
  const totals: Record<string, number> = Object.create(null)
  for (const row of rows) {
    if (typeof row.currency !== "string" || !row.currency || !Number.isSafeInteger(row.cents)) throw new Error("invalid entry")
    const next = (totals[row.currency] ?? 0) + row.cents
    if (!Number.isSafeInteger(next)) throw new Error("total overflow")
    totals[row.currency] = next
  }
  return totals
}
export function mergeLedgers(left: Entry[], right: Entry[]): Entry[] {
  const result: Entry[] = [], known = new Map<string, Entry>()
  for (const row of [...left, ...right]) {
    if (typeof row.id !== "string" || !row.id) throw new Error("invalid id")
    const previous = known.get(row.id)
    if (previous) { if (previous.currency !== row.currency || previous.cents !== row.cents) throw new Error("conflicting duplicate: " + row.id); continue }
    const copy = { ...row }; known.set(row.id, copy); result.push(copy)
  }
  return result
}
`,
    "src/cli.ts": `import { rename, unlink } from "node:fs/promises"
import { parseLines, summarize, type Entry } from "./index"
const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error("usage: bun src/cli.ts INPUT OUTPUT")
const text = JSON.stringify(summarize(parseLines(await Bun.file(input).text()) as Entry[])) + "\\n"
const temporary = output + "." + crypto.randomUUID() + ".tmp"
try { await Bun.write(temporary, text); await rename(temporary, output) }
finally { await unlink(temporary).catch(() => {}) }
`,
  },
  queue: {
    "src/index.ts": `interface Job { work: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void; priority: number; signal?: AbortSignal; abort?: () => void }
export class WorkQueue {
  private jobs: Job[] = []
  private running = 0
  private idle: Array<() => void> = []
  private concurrency: number
  constructor(concurrency = 1) { this.concurrency = this.validate(concurrency) }
  private validate(value: number): number { if (!Number.isInteger(value) || value < 1 || value > 16) throw new Error("invalid concurrency"); return value }
  get active(): number { return this.running }
  get pending(): number { return this.jobs.length }
  setConcurrency(value: number): void { this.concurrency = this.validate(value); this.drain() }
  onIdle(): Promise<void> { return this.running === 0 && this.jobs.length === 0 ? Promise.resolve() : new Promise((resolve) => this.idle.push(resolve)) }
  run<T>(work: () => Promise<T>, options: { priority?: number; signal?: AbortSignal } = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return }
      const job: Job = { work, resolve: resolve as (value: unknown) => void, reject, priority: options.priority ?? 0, signal: options.signal }
      job.abort = () => { const at = this.jobs.indexOf(job); if (at < 0) return; this.jobs.splice(at,1); reject(new DOMException("Aborted", "AbortError")); this.checkIdle() }
      options.signal?.addEventListener("abort", job.abort, { once: true })
      this.jobs.push(job); this.jobs.sort((a,b) => b.priority - a.priority); this.drain()
    })
  }
  private checkIdle(): void { if (this.running === 0 && this.jobs.length === 0) for (const resolve of this.idle.splice(0)) resolve() }
  private drain(): void {
    while (this.running < this.concurrency && this.jobs.length) {
      const job = this.jobs.shift()!
      if (job.abort) job.signal?.removeEventListener("abort", job.abort)
      this.running++
      const finish = () => { this.running--; this.drain(); this.checkIdle() }
      Promise.resolve().then(job.work).then((value) => { finish(); job.resolve(value) }, (error) => { finish(); job.reject(error) })
    }
  }
}
`,
  },
}
