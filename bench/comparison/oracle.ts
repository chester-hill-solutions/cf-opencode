import assert from "node:assert/strict"
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { tasks } from "./protocol"

interface Entry { id: string; currency: string; cents: number }
interface Ledger { parseLines(text: string): unknown[]; parseAmount(value: string): number; summarize(rows: Entry[]): Record<string, number>; mergeLedgers(left: Entry[], right: Entry[]): Entry[] }
interface Queue {
  active: number; pending: number
  run<T>(work: () => Promise<T>, options?: { priority?: number; signal?: AbortSignal }): Promise<T>
  setConcurrency(value: number): void; onIdle(): Promise<void>
}
const tick = async () => { for (let index = 0; index < 30; index++) await Promise.resolve() }
function latch() { let release!: () => void; const promise = new Promise<void>((done) => { release = done }); return { promise, release } }

export async function checkTask(taskID: string, repository: string): Promise<void> {
  const task = tasks.find((candidate) => candidate.id === taskID)
  assert(task, "unknown task")
  const imported = await import(pathToFileURL(resolve(repository, "src/index.ts")).href)
  if (task.repo === "ledger") {
    const ledger: Ledger = imported
    if (taskID === "L1") {
      assert.deepEqual(ledger.parseLines('\uFEFF{"id":"a"}\r\n \t\r\n{"id":"b"}'), [{ id: "a" }, { id: "b" }])
      assert.deepEqual(ledger.parseLines("\n \r\n"), [])
      assert.throws(() => ledger.parseLines('{"id":"a"}\n \nBROKEN\n'), /line\s+3\b/)
    } else if (taskID === "L2") {
      for (const [input, cents] of [["0.10",10],["-0.01",-1],["12.3",1230],["90071992547409.91",Number.MAX_SAFE_INTEGER]] as const) assert.equal(ledger.parseAmount(input), cents)
      for (const input of ["", " 1", "1 ", "+1", "1e2", "Infinity", "1.001", "90071992547409.92"]) assert.throws(() => ledger.parseAmount(input), { name: "Error" }, "invalid amount: " + JSON.stringify(input))
      assert.equal(Object.is(ledger.parseAmount("-0.00"), -0), false)
    } else if (taskID === "L3") {
      const rows = ["__proto__", "constructor", "toString", "USD", "USD"].map((currency,index) => ({ id: String(index), currency, cents: index + 1 }))
      const before = JSON.stringify(rows), result = ledger.summarize(rows)
      assert.equal(Object.hasOwn(result,"__proto__"),true); assert.equal(result.__proto__,1)
      assert.equal(result.constructor,2); assert.equal(result.toString,3); assert.equal(result.USD,9)
      assert.equal(JSON.stringify(rows), before)
      for (const row of [{id:"x",currency:"",cents:1},{id:"x",currency:"USD",cents:1.5},{id:"x",currency:"USD",cents:NaN}]) assert.throws(() => ledger.summarize([row]))
      assert.throws(() => ledger.summarize([{id:"x",currency:"USD",cents:Number.MAX_SAFE_INTEGER},{id:"y",currency:"USD",cents:1}]))
    } else if (taskID === "L4") {
      const a = {id:"a",currency:"USD",cents:1}, b = {id:"b",currency:"USD",cents:2}, c = {id:"c",currency:"EUR",cents:3}
      const merged = ledger.mergeLedgers([a,b],[{...b},c])
      assert.deepEqual(merged,[a,b,c]); merged[0]!.cents=9; assert.equal(a.cents,1)
      assert.throws(() => ledger.mergeLedgers([a],[{...a,cents:2}]))
      assert.throws(() => ledger.mergeLedgers([],[{...a,id:""}]))
    } else if (taskID === "L5") {
      const scratch = await mkdtemp(join(tmpdir(),"r0-23-cli-oracle-"))
      const input = join(scratch,"input.jsonl"), output = join(scratch,"output.json")
      const invoke = async (path: string) => {
        const child = Bun.spawn([process.execPath,resolve(repository,"src/cli.ts"),path,output],{cwd:repository,stdout:"ignore",stderr:"ignore"})
        return child.exited
      }
      try {
        await writeFile(output,"retain existing report\n"); await writeFile(input,"INVALID\n")
        assert.notEqual(await invoke(input),0); assert.equal(await readFile(output,"utf8"),"retain existing report\n")
        assert.notEqual(await invoke(join(scratch,"missing")),0); assert.equal(await readFile(output,"utf8"),"retain existing report\n")
        await writeFile(input,'{"id":"a","currency":"USD","cents":25}\n')
        assert.equal(await invoke(input),0); assert.equal(await readFile(output,"utf8"),'{"USD":25}\n')
        assert.deepEqual((await readdir(scratch)).sort(),["input.jsonl","output.json"])
      } finally { await rm(scratch,{recursive:true,force:true}) }
    }
    return
  }
  const WorkQueue: new (concurrency?: number) => Queue = imported.WorkQueue
  if (taskID === "Q1") {
    const queue = new WorkQueue(1)
    const seen: string[]=[]
    const first = queue.run(async()=>{ throw new Error("expected") }).catch((error: Error)=>{seen.push(error.message)})
    const second = queue.run(()=>{ throw new Error("sync") }).catch((error: Error)=>{seen.push(error.message)})
    const third = queue.run(async()=>{seen.push("done");return 3})
    await tick()
    assert.deepEqual([...seen].sort(),["expected","sync","done"].sort())
    assert.deepEqual(await Promise.all([first,second,third]),[undefined,undefined,3])
    assert.equal(queue.active,0); assert.equal(queue.pending,0)
  } else if (taskID === "Q2") {
    const queue=new WorkQueue(1), gate=latch(), seen:string[]=[]
    const running=queue.run(async()=>{seen.push("running");await gate.promise})
    const waiting=[queue.run(async()=>{seen.push("low")},{priority:-1}),queue.run(async()=>{seen.push("high-a")},{priority:2}),queue.run(async()=>{seen.push("high-b")},{priority:2}),queue.run(async()=>{seen.push("normal")})]
    await tick(); assert.deepEqual(seen,["running"]); gate.release(); await Promise.all([running,...waiting])
    assert.deepEqual(seen,["running","high-a","high-b","normal","low"])
  } else if (taskID === "Q3") {
    const queue=new WorkQueue(1), gate=latch(), aborted=new AbortController(), activeSignal=new AbortController(), early=new AbortController()
    early.abort(); let executed=0, activeFinished=false
    const running=queue.run(async()=>{await gate.promise;activeFinished=true},{signal:activeSignal.signal})
    const canceled=queue.run(async()=>{executed++},{signal:aborted.signal}).then(()=>"unexpected",(error: Error)=>error.name)
    const pre=queue.run(async()=>{executed++},{signal:early.signal}).then(()=>"unexpected",(error: Error)=>error.name)
    const next=queue.run(async()=>{executed++})
    aborted.abort(); activeSignal.abort(); await tick()
    assert.equal(queue.active,1); assert.equal(activeFinished,false); assert.equal(queue.pending,1)
    gate.release(); await Promise.all([running,next]); assert.equal(await canceled,"AbortError"); assert.equal(await pre,"AbortError"); assert.equal(executed,1)
  } else if (taskID === "Q4") {
    for (const limit of [0,-1,1.5,17,NaN,Infinity]) assert.throws(()=>new WorkQueue(limit))
    const queue=new WorkQueue(1), a=latch(), b=latch(), seen:string[]=[]
    const one=queue.run(async()=>{seen.push("a");await a.promise}), two=queue.run(async()=>{seen.push("b");await b.promise}), three=queue.run(async()=>{seen.push("c")})
    await tick(); assert.deepEqual(seen,["a"]); assert.throws(()=>queue.setConcurrency(0)); queue.setConcurrency(2); await tick(); assert.deepEqual(seen,["a","b"])
    queue.setConcurrency(1); a.release(); await tick(); assert.deepEqual(seen,["a","b"]); b.release(); await Promise.all([one,two,three]); assert.deepEqual(seen,["a","b","c"])
  } else if (taskID === "Q5") {
    const queue=new WorkQueue(1), gate=latch(); const seen:string[]=[]
    await queue.onIdle()
    const first=queue.run(async()=>{await gate.promise}), second=queue.run(async()=>{seen.push("second")})
    const waiters=[queue.onIdle().then(()=>seen.push("idle-a")),queue.onIdle().then(()=>seen.push("idle-b"))]
    await tick(); assert.deepEqual(seen,[]); gate.release(); await Promise.all([first,second,...waiters]); assert.deepEqual(seen,["second","idle-a","idle-b"])
    const next=latch(); const work=queue.run(async()=>{await next.promise}); let idle=false
    const another=queue.onIdle().then(()=>{idle=true}); await tick(); assert.equal(idle,false); next.release(); await Promise.all([work,another]); assert.equal(idle,true)
  }
}

if (import.meta.main) {
  const [taskID,repository]=process.argv.slice(2)
  if (!taskID || !repository) throw new Error("usage: oracle.ts TASK REPOSITORY")
  const timer=setTimeout(()=>{console.error("oracle deadline exceeded");process.exit(124)},4000)
  try { await checkTask(taskID,repository); console.log(JSON.stringify({taskID,passed:true})) }
  finally { clearTimeout(timer) }
}
