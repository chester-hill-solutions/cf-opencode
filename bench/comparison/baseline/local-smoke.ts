import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { FROZEN_PROTOCOL_SHA256 } from "./freeze.generated"
import type { TaskReceipt } from "./journal"
import { taskAttemptID } from "./task-request"

const root=resolve(import.meta.dir,"../../..")
const bundle=resolve(root,".wrangler/comparison-preflight/bundle/worker.js")
if(!await Bun.file(bundle).exists())throw new Error("Run baseline/preflight.ts before the local smoke")
const server=createServer();await new Promise<void>((done,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",done)})
const address=server.address();if(!address || typeof address==="string")throw new Error("local port unavailable")
const port=address.port;await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))
const temporary=await mkdtemp(join(tmpdir(),"r0-23-workerd-smoke-"))
const config=JSON.parse(await readFile(resolve(import.meta.dir,"wrangler.local.json"),"utf8"))
config.main=bundle;config.no_bundle=true;config.vars={BENCH_TOKEN:"r0-23-synthetic-local-token",BENCH_PROVIDER_KEY:"synthetic-noncredential",BENCH_PROVIDER_ORG:"org_synthetic",BENCH_TASK_CONFIG:JSON.stringify({enabled:true,protocolSHA256:FROZEN_PROTOCOL_SHA256,spendBudgetUSD:1,deadlineMs:5000,model:{model:"synthetic-chat-model",baseURL:"https://provider.invalid/v1",temperature:0,maxOutputTokens:1024,contextTokens:32768,maxModelCalls:8,requestTimeoutMs:5000}})}
config.name="aboiteau-r0-23-local-"+crypto.randomUUID().slice(0,8)
const configPath=join(temporary,"wrangler.json");await writeFile(configPath,JSON.stringify(config))
const child=Bun.spawn([resolve(root,"node_modules/.bin/wrangler"),"dev","--config",configPath,"--local","--ip","127.0.0.1","--port",String(port),"--persist-to",join(temporary,"state")],{
  cwd:root,stdout:"pipe",stderr:"pipe",env:{...process.env,WRANGLER_SEND_METRICS:"false",WRANGLER_LOG_PATH:join(temporary,"wrangler.log")},
})
const output=(stream:ReadableStream<Uint8Array>)=>new Response(stream).text()
const logs=Promise.all([output(child.stdout),output(child.stderr)])
const base=`http://127.0.0.1:${port}`
const post=(path:string,authenticated=true)=>fetch(base+path,{method:"POST",headers:authenticated?{authorization:"Bearer r0-23-synthetic-local-token"}:{},signal:AbortSignal.timeout(65_000)})
let observation:unknown
try {
  const deadline=Date.now()+30_000
  for(;;){
    if(child.exitCode!==null)throw new Error("local Workerd exited before readiness")
    try{if((await fetch(base+"/health",{signal:AbortSignal.timeout(1000)})).ok)break}catch{}
    if(Date.now()>=deadline)throw new Error("local Workerd readiness timed out")
    await Bun.sleep(100)
  }
  const ready=await fetch(base+"/smoke/ready",{headers:{authorization:"Bearer r0-23-synthetic-local-token"}})
  assert.equal(ready.status,200);assert.deepEqual(await ready.json(),{ready:true,configReady:true,credentialReady:true,workspaceReady:true})
  assert.equal((await post("/probe/synthetic",false)).status,401)
  const response=await post("/probe/synthetic")
  const value=await response.json() as {passed?:boolean;mode?:string;tools?:Array<{tool:string}>;providerCalls?:number}
  assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.passed,true);assert.equal(value.mode,"simulated-plane");assert.equal(value.providerCalls,0)
  assert.deepEqual(value.tools?.map(entry=>entry.tool),["write","read","edit","shell","read"])
  assert.equal((await post("/probe/synthetic")).status,409)
  const cached=await fetch(base+"/receipt/synthetic",{headers:{authorization:"Bearer r0-23-synthetic-local-token"},signal:AbortSignal.timeout(5000)})
  assert.equal(cached.status,200);assert.deepEqual(await cached.json(),{cached:true,receipt:value})
  const cleanup=await post("/cleanup/synthetic");assert.equal(cleanup.status,200);assert.deepEqual(await cleanup.json(),{runtimeStopped:true,stateCleared:true})
  const taskResponse=await post("/probe/task")
  const taskProbe=await taskResponse.json() as {passed:boolean;receipt:TaskReceipt;externalProviderCalls:number;broker?:{synthetic?:boolean;externalProviderCalls?:number;calls?:Array<{status:string}>;refusals?:unknown[]}}
  assert.equal(taskResponse.status,200,JSON.stringify(taskProbe));assert.equal(taskProbe.passed,true);assert.equal(taskProbe.externalProviderCalls,0)
  assert.equal(taskProbe.receipt.modelCalls.length,6);assert.equal(taskProbe.receipt.tools.length,5);assert.equal(taskProbe.receipt.modelUSD,null);assert.equal(taskProbe.receipt.oraclePassed,null)
  assert.equal(taskProbe.broker?.synthetic,true);assert.equal(taskProbe.broker.externalProviderCalls,0);assert.equal(taskProbe.broker.calls?.length,6);assert.equal(taskProbe.broker.calls.every(call=>call.status==="complete"),true);assert.deepEqual(taskProbe.broker.refusals,[])
  assert.equal((await post("/probe/task")).status,409)
  const taskCleanup=await post("/cleanup/task");assert.equal(taskCleanup.status,200);assert.deepEqual(await taskCleanup.json(),{runtimeStopped:true,coordinatorDisposed:true,cleanupRecorded:true,stopFenceRecorded:true,providerStop:"unproven",receiptRetained:true,alarmsDisabled:true})
  const id=taskAttemptID("L1","cold",1,FROZEN_PROTOCOL_SHA256), taskPath="/tasks/"+id
  const submit=(taskID="L1")=>fetch(base+taskPath,{method:"POST",headers:{authorization:"Bearer r0-23-synthetic-local-token","content-type":"application/json"},body:JSON.stringify({id,taskID,protocolSHA256:FROZEN_PROTOCOL_SHA256,condition:"cold",repetition:1}),signal:AbortSignal.timeout(5000)})
  const admitted=await Promise.all([submit(),submit()])
  assert.deepEqual(admitted.map(response=>response.status).sort(),[200,202])
  const admissions=await Promise.all(admitted.map(response=>response.json() as Promise<{accepted:boolean}>))
  assert.equal(admissions.filter(response=>response.accepted).length,1)
  let receipt:TaskReceipt|null=null
  for(let count=0;count<30;count++){
    const response=await fetch(base+taskPath+"/receipt",{headers:{authorization:"Bearer r0-23-synthetic-local-token"},signal:AbortSignal.timeout(5000)})
    receipt=(await response.json() as {receipt:TaskReceipt|null}).receipt
    if(receipt?.phase==="failed")break
    await Bun.sleep(50)
  }
  assert.equal(receipt?.phase,"failed");assert.equal(receipt.modelCalls.length,0)
  const repeated=await submit();assert.equal(repeated.status,200);assert.equal((await repeated.json() as {accepted:boolean}).accepted,false)
  assert.equal((await submit("L2")).status,409)
  assert.equal((await post(taskPath+"/observe")).status,200)
  const nativeAbsentCleanup=await post(taskPath+"/cleanup");assert.equal(nativeAbsentCleanup.status,200)
  const nativeAbsentCleanupResult=await nativeAbsentCleanup.json() as {runtimeStopped:boolean;coordinatorDisposed:boolean;cleanupRecorded:boolean}
  assert.equal(nativeAbsentCleanupResult.runtimeStopped,true);assert.equal(nativeAbsentCleanupResult.cleanupRecorded,true)
  const retained=await fetch(base+taskPath+"/receipt",{headers:{authorization:"Bearer r0-23-synthetic-local-token"},signal:AbortSignal.timeout(5000)})
  const retainedReceipt=(await retained.json() as {receipt:TaskReceipt}).receipt
  assert.equal(retainedReceipt.cleanup,"stopped");assert.equal(retainedReceipt.cleanupCoordinatorDisposed,nativeAbsentCleanupResult.coordinatorDisposed)
  const afterCleanup=await submit();assert.equal(afterCleanup.status,200);assert.equal((await afterCleanup.json() as {accepted:boolean}).accepted,false)
  observation={schemaVersion:3,kind:"local-precompiled-sdk-smoke",passed:true,protocolSHA256:FROZEN_PROTOCOL_SHA256,compatibilityDate:config.compatibility_date,bun:Bun.version,platform:process.platform,arch:process.arch,probe:value,taskProbe,nativeAbsentTask:receipt,nativeAbsentCleanup:nativeAbsentCleanupResult,cleanupReceipt:retainedReceipt,concurrentAdmissionChecked:true,taskIdentityAndCleanupTombstoneChecked:true,authenticationChecked:true,cachedPassRefused:true,cachedReceiptLabeled:true,localStateCleanup:true,providerCalls:0,nativeLinux:"unmeasured",realModelEffectiveness:"unmeasured"}
} catch(error){process.exitCode=1;console.error(error)}
finally {
  child.kill("SIGINT")
  let timer:ReturnType<typeof setTimeout>|undefined
  await Promise.race([child.exited,new Promise<void>(done=>{timer=setTimeout(()=>{child.kill(9);done()},5000)})]);if(timer)clearTimeout(timer)
  const recorded=await logs
  if(process.exitCode)console.error(recorded.join("\n").slice(-12_000))
  await rm(temporary,{recursive:true,force:true})
}
if(observation)console.log(JSON.stringify(observation,null,2))
