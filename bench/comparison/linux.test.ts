import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LinuxToolPlane, type Exec } from "./baseline/linux"
import { latch } from "./test-support"

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function plane(){
  const root=await mkdtemp(join(tmpdir(),"r0-23-linux-adapter-"));roots.push(root)
  const exec:Exec=async(argv,options)=>{
    const process=Bun.spawn(argv,{cwd:options.cwd,stdin:options.stdin,stdout:"pipe",stderr:"pipe"})
    return {stdout:process.stdout,stderr:process.stderr,exitCode:process.exited,kill:()=>{if(process.exitCode===null)process.kill(9)}}
  }
  return {root,tools:new LinuxToolPlane(exec,root),signal:new AbortController().signal}
}

test("Linux adapter writes, reads, edits and executes a real local command",async()=>{
  const {root,tools,signal}=await plane()
  await tools.execute("write",{path:"probe.txt",content:"alpha\n"},signal)
  expect(await tools.execute("read",{path:"probe.txt"},signal)).toBe("alpha\n")
  await tools.execute("edit",{path:"probe.txt",oldText:"alpha",newText:"beta"},signal)
  expect(await tools.execute("shell",{command:"cat probe.txt"},signal)).toBe("beta\n")
  expect(await readFile(join(root,"probe.txt"),"utf8")).toBe("beta\n")
})

test("Linux file tools refuse escape paths and symlinks without modifying the target",async()=>{
  const {root,tools,signal}=await plane(),outside=await mkdtemp(join(tmpdir(),"r0-23-outside-"));roots.push(outside)
  const file=join(outside,"unchanged.txt");await writeFile(file,"retain")
  await symlink(file,join(root,"escape"))
  await expect(tools.execute("write",{path:"escape",content:"changed"},signal)).rejects.toThrow()
  await expect(tools.execute("read",{path:"../escape"},signal)).rejects.toThrow()
  expect(await readFile(file,"utf8")).toBe("retain")
})

test("Linux adapter refuses ambiguous edits, large files and command failures",async()=>{
  const {root,tools,signal}=await plane()
  await writeFile(join(root,"repeated"),"x x")
  await expect(tools.execute("edit",{path:"repeated",oldText:"x",newText:"y"},signal)).rejects.toThrow()
  await writeFile(join(root,"large"),"x".repeat(70_000))
  await expect(tools.execute("read",{path:"large"},signal)).rejects.toThrow()
  await expect(tools.execute("shell",{command:"exit 7"},signal)).rejects.toThrow("7")
  await expect(tools.execute("shell",{command:"bun -e 'process.stdout.write(\"x\".repeat(70000))'"},signal)).rejects.toThrow("limit")
})

test("adapter rejects pre-aborted work and returns after an active direct process is aborted",async()=>{
  const {tools,signal}=await plane(),early=new AbortController();early.abort()
  await expect(tools.execute("write",{path:"not-created",content:"x"},early.signal)).rejects.toThrow()
  const later=new AbortController()
  const work=tools.execute("shell",{command:"exec bun -e 'setInterval(()=>{},1000)'"},later.signal)
  const timer=setTimeout(()=>later.abort(),100)
  try{await expect(work).rejects.toThrow("aborted")}finally{clearTimeout(timer)}
  expect(signal.aborted).toBe(false)
})

test("caller abort returns even when direct-process exit is unconfirmed",async()=>{
  const controller=new AbortController();let kills=0
  const tools=new LinuxToolPlane(async()=>({stdout:new ReadableStream(),stderr:new ReadableStream(),exitCode:new Promise<number>(()=>{}),kill(){kills++}}),"/unused-synthetic-root")
  const work=tools.execute("shell",{command:"synthetic-only"},controller.signal)
  await Promise.resolve();controller.abort()
  await expect(work).rejects.toThrow("stop unproven")
  expect(kills).toBeGreaterThan(0)
})

test("abort during process launch returns promptly and stops a late process", async () => {
  const controller = new AbortController(), launch = latch(), entered = latch()
  let kills = 0
  const tools = new LinuxToolPlane(async () => {
    entered.release(); await launch.promise
    return { stdout: null, stderr: null, exitCode: Promise.resolve(0), kill() { kills++ } }
  }, "/unused-synthetic-root")
  const work = tools.execute("shell", { command: "synthetic-only" }, controller.signal).then(() => "success", () => "aborted")
  await entered.promise; controller.abort()
  const observed = await Promise.race([work, Bun.sleep(25).then(() => "stalled")])
  launch.release(); await work; await Promise.resolve()
  expect(observed).toBe("aborted")
  expect(kills).toBeGreaterThan(0)
})

test("an output limit returns even when stream cancellation never acknowledges", async () => {
  const controller = new AbortController()
  const tools = new LinuxToolPlane(async () => ({
    stdout: new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(70_000)) }, cancel() { return new Promise<void>(() => {}) } }),
    stderr: null, exitCode: Promise.resolve(0), kill() {},
  }), "/unused-synthetic-root")
  const work = tools.execute("shell", { command: "synthetic-only" }, controller.signal).then(() => "success", error => String(error))
  const observed = await Promise.race([work, Bun.sleep(25).then(() => "stalled")])
  controller.abort(); await work
  expect(observed).toContain("limit")
})
