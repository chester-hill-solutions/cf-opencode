/** Disposable Linux-plane adapter. The container, not the Linux UID, is the trust boundary. */
export interface ToolPlane { execute(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string> }
export interface ToolProcess {
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  exitCode: Promise<number>
  kill(signal?: number): void
}
export type Exec = (argv: string[], options: { cwd: string; stdin?: ReadableStream<Uint8Array>; signal: AbortSignal }) => Promise<ToolProcess>
export class UncertainToolOutcome extends Error {}
export class ToolExitError extends Error {}

const FILE_HANDLER = String.raw`
const fs = await import("node:fs/promises"), path = await import("node:path");
const input = JSON.parse(await Bun.stdin.text());
const root = await fs.realpath(process.cwd());
if (typeof input.path !== "string" || input.path.includes(String.fromCharCode(0))) throw new Error("invalid path");
const target = path.resolve(root,input.path);
if (!target.startsWith(root + path.sep)) throw new Error("path outside fixture");
const existing = await fs.realpath(input.kind === "read" || input.kind === "edit" ? target : path.dirname(target));
if (existing !== root && !existing.startsWith(root + path.sep)) throw new Error("symlink outside fixture");
if (input.kind === "read") {
  if ((await fs.stat(target)).size > 65536) throw new Error("file exceeds tool limit");
  process.stdout.write(await fs.readFile(target,"utf8"));
} else if (input.kind === "write") {
  try { const actual = await fs.realpath(target); if (!actual.startsWith(root + path.sep)) throw new Error("symlink outside fixture") }
  catch (error) { if (error.code !== "ENOENT") throw error }
  if (typeof input.content !== "string" || Buffer.byteLength(input.content) > 65536) throw new Error("invalid content");
  await fs.writeFile(target,input.content); process.stdout.write("written");
} else if (input.kind === "edit") {
  if (typeof input.oldText !== "string" || !input.oldText || typeof input.newText !== "string") throw new Error("invalid edit");
  if ((await fs.stat(target)).size > 65536) throw new Error("file exceeds tool limit");
  const before = await fs.readFile(target,"utf8");
  if (before.split(input.oldText).length !== 2) throw new Error("edit requires exactly one match");
  const after = before.replace(input.oldText,input.newText);
  if (Buffer.byteLength(after) > 65536) throw new Error("file exceeds tool limit");
  await fs.writeFile(target,after); process.stdout.write("edited");
} else throw new Error("unknown operation");
`

async function bounded(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<string> {
  if (!stream) return ""
  const reader=stream.getReader(), chunks:Uint8Array[]=[]; let bytes=0
  const cancel=()=>{void reader.cancel().catch(()=>{})};signal.addEventListener("abort",cancel,{once:true});if(signal.aborted)cancel()
  try { for (;;) { const part=await reader.read(); if(part.done)break; bytes+=part.value.byteLength; if(bytes>limit)throw new Error("tool output exceeds limit"); chunks.push(part.value) } }
  finally { signal.removeEventListener("abort",cancel);void reader.cancel().catch(()=>{}); reader.releaseLock() }
  const output=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length}
  return new TextDecoder().decode(output)
}

export class LinuxToolPlane implements ToolPlane {
  constructor(private readonly exec: Exec, private readonly root: string, private readonly lifetime?: AbortSignal) {}
  async execute(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    if(!["read","write","edit","shell"].includes(tool)) throw new Error("unsupported tool")
    if(new TextEncoder().encode(JSON.stringify(input)).length>80_000) throw new Error("tool input exceeds limit")
    if(tool==="shell" && (typeof input.command!=="string" || input.command.length>8192)) throw new Error("invalid shell command")
    const localStop=new AbortController()
    const deadline=AbortSignal.timeout(30_000), combined=AbortSignal.any([signal,deadline,localStop.signal,...(this.lifetime?[this.lifetime]:[])])
    combined.throwIfAborted()
    const stdin=tool==="shell"?undefined:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify({...input,kind:tool})));controller.close()}})
    let process:ToolProcess|undefined
    let rejectAbort:(error:Error)=>void=()=>{}
    const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject})
    const stop=()=>{try{process?.kill(9)}catch{}}
    const abort=()=>{stop();rejectAbort(new UncertainToolOutcome("tool observation aborted; descendant stop unproven"))}; combined.addEventListener("abort",abort,{once:true});if(combined.aborted)abort()
    try {
      const launching=this.exec(tool==="shell"?["bash","-lc",String(input.command)]:["bun","-e",FILE_HANDLER],{cwd:this.root,stdin,signal:combined})
      void launching.then(child=>{process=child;if(combined.aborted){stop();void child.stdout?.cancel().catch(()=>{});void child.stderr?.cancel().catch(()=>{})}},()=>{})
      process=await Promise.race([launching,aborted])
      const [code,stdout,stderr]=await Promise.race([Promise.all([process.exitCode,bounded(process.stdout,65_536,combined),bounded(process.stderr,65_536,combined)]),aborted])
      if(combined.aborted) throw new UncertainToolOutcome("tool observation aborted; descendant stop unproven")
      if(code!==0) throw new ToolExitError(`tool exited ${code}: ${stderr.slice(0,2048)}`)
      return stdout
    } catch(error) {
      localStop.abort()
      stop()
      if(error instanceof ToolExitError || error instanceof UncertainToolOutcome)throw error
      throw new UncertainToolOutcome(`${error instanceof Error?error.message.slice(0,2048):"tool transport failed"}; process/descendant stop unproven`)
    }
    finally { combined.removeEventListener("abort",abort) }
  }
}

/** Explicitly simulated plane, only for local SDK wiring tests. */
export class SimulatedToolPlane implements ToolPlane {
  private files=new Map<string,string>()
  async execute(tool:string,input:Record<string,unknown>,signal:AbortSignal):Promise<string> {
    signal.throwIfAborted();const path=String(input.path)
    if(tool==="write"){this.files.set(path,String(input.content));return "written"}
    if(tool==="read"){const content=this.files.get(path);if(content===undefined)throw new Error("missing file");return content}
    if(tool==="edit"){const before=this.files.get(path);if(!before || before.split(String(input.oldText)).length!==2)throw new Error("missing/ambiguous edit");this.files.set(path,before.replace(String(input.oldText),String(input.newText)));return "edited"}
    if(tool==="shell" && input.command==="test $(cat probe.txt) = beta && bun --version" && this.files.get("probe.txt")==="beta\n") return "simulated-shell-success"
    throw new Error("unsupported simulated operation")
  }
}
