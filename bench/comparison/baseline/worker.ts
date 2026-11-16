import { DurableObject } from "cloudflare:workers"
import { Lifecycle } from "agents/lifecycle"
import { OpenCodeHarness } from "agents/harness/opencode"
import { OpenCodeWorkerd } from "@opencode/sdk/workerd"
import { bearerAuthorized } from "../../../src/control-auth"
import { LinuxToolPlane, SimulatedToolPlane, type ToolPlane } from "./linux"
import { modelID, providerID, probePlugin, steps } from "./provider"
import { parseTaskConfig } from "./task-request"
import { FROZEN_PROTOCOL_SHA256 } from "./freeze.generated"
import { qualifySmokeEvaluator } from "./evaluator"
export { TaskBaseline } from "./task-worker"
export { SyntheticTaskProbe } from "./task-probe"
export { NativeQualification } from "./native-qualification"
export { SmokeProvider, SmokeEgress, SyntheticSmokeProvider } from "./smoke-provider"
export { SmokeConversation } from "./aboiteau-arm"
export { Settings } from "../../../src/settings-do"
export { SmokeEvaluator } from "./evaluator"

export type Bindings = ComparisonBindings

class HarnessProbe extends DurableObject<Bindings> {
  private readonly lifecycle: Lifecycle<Bindings>
  private readonly harness: OpenCodeHarness
  constructor(ctx:DurableObjectState,env:Bindings,plane:ToolPlane,private readonly mode:"simulated-plane"|"native-linux") {
    super(ctx,env)
    const plugin=probePlugin(plane,async(tool,result)=>{
      const observations=await ctx.storage.get<Array<{tool:string;bytes:number}>>("probe-tools")??[]
      observations.push({tool,bytes:new TextEncoder().encode(result).length});await ctx.storage.put("probe-tools",observations)
    })
    this.harness=new OpenCodeHarness({opencode:({storage})=>OpenCodeWorkerd.create({storage,config:{default_agent:"build",experimental:{background_compaction:false},agents:{title:{disabled:true}}},models:{fetch:false},plugins:[plugin]}),defaults:{model:{providerID,id:modelID},agent:"build"}})
    this.lifecycle=Lifecycle.install(this).use(this.harness)
  }
  async fetch(request:Request):Promise<Response> {
    if(request.method==="GET" && new URL(request.url).pathname==="/receipt")return Response.json({cached:true,receipt:await this.ctx.storage.get("probe-receipt")??null})
    if(request.method!=="POST")return new Response("not found",{status:404})
    await this.lifecycle.start()
    if(new URL(request.url).pathname==="/cleanup") {
      await this.harness.abort();await this.harness.dispose()
      if(this.ctx.container){await this.ctx.container.destroy();if(this.ctx.container.running)return Response.json({error:"stop unconfirmed"},{status:503})}
      await this.ctx.storage.deleteAll();return Response.json({runtimeStopped:true,stateCleared:true})
    }
    if(new URL(request.url).pathname!=="/probe")return new Response("not found",{status:404})
    if(await this.ctx.storage.get("probe-attempted"))return Response.json({error:"fixed one-shot probe already attempted; inspect stored receipt, do not count cached success as a new run"},{status:409})
    await this.ctx.storage.put("probe-attempted",true)
    try {
      const receipt=await this.harness.submit("Run the fixed probe tools and report the result.",{operationId:"r0-23-model-free-probe"})
      const result=await this.harness.wait(receipt.operationId,{signal:AbortSignal.timeout(60_000)})
      const tools=await this.ctx.storage.get<Array<{tool:string;bytes:number}>>("probe-tools")??[]
      const passed=result.status==="done" && result.text?.includes("R0_23_TOOL_WIRING_COMPLETE") && tools.length===steps.length
      const observation={schemaVersion:1,kind:"model-free-harness-fit",mode:this.mode,passed,status:result.status,reason:result.reason??null,tools,providerCalls:0,modelEffectiveness:"unmeasured",descendantStop:"unmeasured"}
      await this.ctx.storage.put("probe-receipt",observation)
      return Response.json(observation,{status:passed?200:422})
    } catch(error) {
      const observation={mode:this.mode,passed:false,error:error instanceof Error?error.message:"probe failed",providerCalls:0}
      await this.ctx.storage.put("probe-receipt",observation)
      return Response.json(observation,{status:422})
    }
  }
}

export class SyntheticHarnessProbe extends HarnessProbe {
  constructor(ctx:DurableObjectState,env:Bindings){super(ctx,env,new SimulatedToolPlane(),"simulated-plane")}
}
export class LinuxBaselineProbe extends HarnessProbe {
  constructor(ctx:DurableObjectState,env:Bindings){
    const exec=async(argv:string[],options:Parameters<ConstructorParameters<typeof LinuxToolPlane>[0]>[1])=>{
      const container=ctx.container
      if(!container)throw new Error("native container binding required")
      if(!container.running){const image=container.images.evented;if(!image)throw new Error("pinned evented image required");container.start({image,entrypoint:["sleep","infinity"],enableInternet:false,instance:{vcpu:1,memoryMib:2048,diskMb:8192}});await container.setInactivityTimeout(120_000)}
      const setup=await container.exec(["mkdir","-p","/workspace/r0-23"]);if((await setup.output()).exitCode!==0)throw new Error("fixture directory setup failed")
      return container.exec(argv,{...options,stdout:"pipe",stderr:"pipe"})
    }
    super(ctx,env,new LinuxToolPlane(exec,"/workspace/r0-23"),"native-linux")
  }
}

export default {async fetch(request:Request,env:Bindings):Promise<Response>{
  const path=new URL(request.url).pathname
  if(path==="/health")return new Response("ok")
  if(!bearerAuthorized(request.headers.get("authorization"),env.BENCH_TOKEN))return new Response("unauthorized",{status:401})
  if(path==="/smoke/ready" && request.method==="GET"){
    let configReady=false
    try{parseTaskConfig(env.BENCH_TASK_CONFIG,FROZEN_PROTOCOL_SHA256);configReady=true}catch{}
    const credentialReady=Boolean(env.BENCH_PROVIDER_KEY),workspaceReady=Boolean(env.BENCH_PROVIDER_ORG)
    return Response.json({ready:configReady&&credentialReady&&workspaceReady,configReady,credentialReady,workspaceReady},{status:configReady&&credentialReady&&workspaceReady?200:503})
  }
  const qualification=path.match(/^\/qualify-evaluator\/(base|reference)\/(L1|Q1)$/)
  if(qualification && request.method==="POST")return Response.json(await qualifySmokeEvaluator(env,qualification[2] as "L1"|"Q1",qualification[1] as "base"|"reference"))
  if(path.startsWith("/native/"))return env.NATIVE.getByName("r0-23-native-qualification-v1").fetch(request)
  const evaluation=path.match(/^\/evaluate\/([a-zA-Z0-9][a-zA-Z0-9_-]{7,95})$/)
  if(evaluation && request.method==="POST")return env.EVALUATOR.getByName(evaluation[1]!).fetch(request)
  if(path==="/smoke/usage" && request.method==="GET")return env.SMOKE_PROVIDER.getByName("r0-23-smoke-budget").fetch(request)
  if(path==="/smoke/cleanup-bucket" && request.method==="POST"){
    let deleted=0
    for(let page=0;page<10;page++){const listed=await env.CHECKPOINTS.list({limit:1000});if(!listed.objects.length)return Response.json({objectsRemaining:0,deleted});await env.CHECKPOINTS.delete(listed.objects.map(object=>object.key));deleted+=listed.objects.length}
    return Response.json({error:"cleanup object bound reached",deleted},{status:503})
  }
  const aboiteau=path.match(/^\/aboiteau\/([a-zA-Z0-9][a-zA-Z0-9_-]{7,79})\/(prepare|submit|status|snapshot|cleanup)$/)
  if(aboiteau){const forwarded=new URL(request.url);forwarded.pathname="/aboiteau/"+aboiteau[2];return env.CONVERSATION.getByName(aboiteau[1]!).fetch(new Request(forwarded,request))}
  const task=path.match(/^\/tasks\/([a-zA-Z0-9][a-zA-Z0-9_-]{7,79})(?:\/(receipt|snapshot|cleanup|observe))?$/)
  if(task && ((request.method==="POST" && (!task[2] || task[2]==="cleanup" || task[2]==="observe")) || (request.method==="GET" && (task[2]==="receipt" || task[2]==="snapshot"))))return env.TASKS.getByName(task[1]!).fetch(request)
  if(!((request.method==="POST" && ["/probe/synthetic","/probe/native","/cleanup/synthetic","/cleanup/native","/probe/task","/cleanup/task"].includes(path)) || (request.method==="GET" && ["/receipt/synthetic","/receipt/native","/receipt/task"].includes(path))))return new Response("not found",{status:404})
  const target=path.endsWith("/task")?env.TASK_PROBE:path.endsWith("/native")?env.BASELINE:env.SYNTHETIC
  const action=path.startsWith("/cleanup")?"cleanup":path.startsWith("/receipt")?"receipt":"probe"
  return target.getByName("r0-23-fixed-probe-v1").fetch("https://probe/"+action,{method:request.method})
}}
