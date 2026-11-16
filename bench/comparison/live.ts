import { mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises"
import { resolve, join } from "node:path"
import { homedir } from "node:os"
import { artifactManifest, protocolDigest } from "./prepare"
import { taskAttemptID } from "./baseline/task-request"
import { SMOKE_SCOPE as scope } from "./baseline/smoke-scope"
import { QUALIFICATION_ARTIFACT } from "../../scripts/native-storage-qualification/artifact"
import { FROZEN_PROTOCOL_SHA256 } from "./baseline/freeze.generated"
import { loadActiveConsoleCredential } from "./operator-credential"

const root = resolve(import.meta.dir, "../..")
const directory = resolve(root, ".wrangler", scope.id)
const configPath = join(directory, "wrangler.json")
const statePath = join(directory, "operator.json")
const evidencePath = resolve(root, "docs/evidence/r0-23-live-2026-11-15-08.json")
const action = process.argv[2] ?? "all"
if(!["all","native","smoke","cleanup"].includes(action))throw new Error("unknown live action")
if(action!=="cleanup" && FROZEN_PROTOCOL_SHA256!==protocolDigest())throw new Error("Preflight generated source is stale; rebuild before live execution")
type State = { worker: string; bucket: string; token: string; vault: string; url?: string; deployed?: boolean; deploymentAttempted?: boolean; bucketCreated?: boolean; bucketAttempted?: boolean; cleaned?: boolean }
let state: State
let report: Record<string, unknown> = { schemaVersion: 1, scope, startedAt: new Date().toISOString(), protocolSHA256: protocolDigest(), native: [], attempts: [], cleanup: {} }

async function save() { await writeFile(statePath, JSON.stringify(state)); await chmod(statePath, 0o600); await writeFile(evidencePath, JSON.stringify(report, null, 2) + "\n") }
async function command(args: string[], stdin?: string, allowFailure = false) {
  const child = Bun.spawn([resolve(root, "node_modules/.bin/wrangler"), ...args, "--config", configPath], { cwd: directory, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(directory, "wrangler.log") } })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  await writeFile(join(directory, args[0] + "-last.log"), out + err)
  if (code && !allowFailure) throw new Error("Wrangler " + args.slice(0, 2).join(" ") + " failed; inspect private operation log")
  return { code, output: out + err, stdout: out }
}
async function cloudToken(): Promise<string> {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN
  const data = Bun.TOML.parse(await readFile(join(homedir(), ".wrangler/config/default.toml"), "utf8")) as Record<string, unknown>
  if (typeof data.oauth_token !== "string") throw new Error("Wrangler OAuth token unavailable")
  return data.oauth_token
}
async function cloud(path: string, method = "GET") {
  return fetch(`https://api.cloudflare.com/client/v4/accounts/${scope.accountID}${path}`, { method, headers: { authorization: "Bearer " + await cloudToken() }, signal: AbortSignal.timeout(30_000) })
}
async function call(path: string, method = "POST", body?: unknown, allowFailure = false): Promise<Record<string, unknown>> {
  if (!state.url) throw new Error("deployed URL missing")
  const response = await fetch(state.url + path, { method, headers: { authorization: "Bearer " + state.token, ...(body===undefined?{}:{"content-type": "application/json"}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(125_000) })
  let value:Record<string,unknown>
  const responseText=await response.text()
  try {value=JSON.parse(responseText)} catch {
    const failures=report.httpFailures as unknown[]??[]
    failures.push({path,status:response.status,contentType:response.headers.get("content-type"),ray:response.headers.get("cf-ray"),excerpt:responseText.slice(0,300).replaceAll(state.token,"[redacted]")})
    report.httpFailures=failures;await save()
    throw new Error(`staging action ${path} returned non-JSON HTTP ${response.status}`)
  }
  if (!response.ok && !allowFailure) throw new Error(`staging action ${path} returned ${response.status}`)
  return { ...value, httpStatus: response.status }
}
async function nativeRecord(path: string, method = "POST") {
  const value = await call(path, method)
  ;(report.native as unknown[]).push({ path, observedAt: new Date().toISOString(), value }); await save(); return value
}
async function pollNative(phase: string) {
  for (let n = 0; n < 120; n++) {
    const value = await call("/native/status", "GET"), receipt = value.receipt as { phase?: string; checks?: Array<{passed:boolean}> }
    if (receipt?.phase === "failed") { (report.native as unknown[]).push(value); await save(); throw new Error("native qualification failed; retained receipt") }
    if (receipt?.phase === phase) { (report.native as unknown[]).push(value); await save(); return value }
    await Bun.sleep(1000)
  }
  throw new Error("native phase observation timed out")
}
async function deploy() {
  // The v2 CLI's active connection is authoritative; legacy auth.json can hold
  // an inactive key even while the selected workspace is signed in through OAuth.
  const connection=await loadActiveConsoleCredential()
  report.providerConnection={source:"opencode auth export opencode; active OAuth only",workspace:connection.workspace,expiresAt:connection.expiresAt,authenticatedConfigHTTPStatus:200,authenticatedCatalogHTTPStatus:200};await save()
  // Let Wrangler refresh its existing OAuth session before direct read-only API checks.
  await command(["whoami","--json"])
  const priorNames=["r0-23-live-2026-11-15.json","r0-23-live-2026-11-15-02.json","r0-23-live-2026-11-15-03.json","r0-23-live-2026-11-15-04.json"]
  for(const name of priorNames) {
    const prior=JSON.parse(await readFile(resolve(root,"docs/evidence",name),"utf8"))
    if(!prior.cleanup?.workerAbsent || !prior.cleanup?.bucketAbsent || !prior.cleanup?.ownedApplicationsAbsent)throw new Error("prior scope cleanup requires reconciliation")
    if(prior.attempts?.length && (!Array.isArray(prior.providerUsage?.calls) || prior.providerUsage.calls.length!==0))throw new Error("prior provider dispatches require total-budget reconciliation")
  }
  const refusedName="r0-23-live-2026-11-15-05.json"
  const refused=JSON.parse(await readFile(resolve(root,"docs/evidence",refusedName),"utf8"))
  const refusedCalls=refused.providerUsage?.calls
  if(!refused.cleanup?.workerAbsent || !refused.cleanup?.bucketAbsent || !refused.cleanup?.ownedApplicationsAbsent || !Array.isArray(refusedCalls) || refusedCalls.length!==1 || refusedCalls[0].upstreamStatus!==401 || refusedCalls[0].status!=="unknown")throw new Error("prior refused request requires reconciliation")
  const lastName="r0-23-live-2026-11-15-06.json",last=JSON.parse(await readFile(resolve(root,"docs/evidence",lastName),"utf8"))
  if(!last.cleanup?.workerAbsent || !last.cleanup?.bucketAbsent || !last.cleanup?.ownedApplicationsAbsent || !Array.isArray(last.providerUsage?.calls) || last.providerUsage.calls.length!==0)throw new Error("prior interrupted scope requires reconciliation")
  const observedName="r0-23-live-2026-11-15-07.json",observed=JSON.parse(await readFile(resolve(root,"docs/evidence",observedName),"utf8")),aggregate=observed.providerUsageAtOperatorInterruption
  if(!observed.cleanup?.workerAbsent || !observed.cleanup?.bucketAbsent || !observed.cleanup?.ownedApplicationsAbsent || aggregate?.completeCount!==19 || aggregate?.pendingOrUnknownCount!==0 || typeof aggregate?.publishedRateEstimatedUSD!=="number" || aggregate.publishedRateEstimatedUSD>scope.priorKnownCostReserveUSD)throw new Error("prior known provider usage requires reconciliation")
  report.priorScopeEvidence=[...priorNames,refusedName,lastName,observedName];report.priorProviderDispatches=20
  report.priorUnknownCostReserveUSD=scope.priorUnknownCostReserveUSD
  report.priorKnownCostReserveUSD=scope.priorKnownCostReserveUSD
  report.priorKnownRateEstimateUSD=aggregate.publishedRateEstimatedUSD
  report.priorCostReconciliation="The inactive legacy key was rejected with 401. Its ledger remains unknown; a separate conservative reserve is withheld from this continuation's budget, without asserting zero billing."
  await save()
  const existing = await cloud(`/workers/scripts/${scope.worker}`)
  if (existing.status !== 404) throw new Error("refusing to overwrite an existing or unverified Worker")
  const bucket = await cloud(`/r2/buckets/${scope.bucket}`)
  if (bucket.status !== 404) throw new Error("refusing to reuse an existing or unverified bucket")
  console.log("Creating isolated staging bucket and Worker", scope.worker)
  report.preexistingApplicationIDs=(await applications()).map(app=>app.id)
  state.bucketAttempted=true;await save()
  await command(["r2", "bucket", "create", scope.bucket]); state.bucketCreated = true; await save()
  state.deploymentAttempted=true;await save()
  let deployed=await command(["deploy"],undefined,true)
  const deployments:Array<{exitCode:number;partialContainerSettings:boolean}>=[]
  for(let n=0;n<3;n++) {
    const partial=deployed.output.includes("Durable Object-managed Container application settings were not fully applied")
    deployments.push({exitCode:deployed.code,partialContainerSettings:partial});report.deploymentAttempts=deployments;await save()
    if(!deployed.code)break
    if(!partial || n===2)throw new Error("staging deployment failed; retained operation log")
    console.log("Retrying the same owned Worker deployment after partial container settings application")
    await Bun.sleep(5000)
    deployed=await command(["deploy"],undefined,true)
  }
  state.deployed = true
  state.url = deployed.output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0]
  if (!state.url || !new URL(state.url).hostname.startsWith(scope.worker + ".")) throw new Error("staging URL not verified")
  await save()
  await command(["secret", "bulk"], JSON.stringify({ BENCH_TOKEN: state.token, API_TOKEN: state.token, VAULT_MASTER_KEY: state.vault }))
  // Read-only readiness observation tolerates propagation of the new version
  // and secrets. It never repeats a native action or a paid dispatch.
  let ready=false
  for(let n=0;n<30;n++) {
    try {await call("/native/status","GET");ready=true;break} catch {await Bun.sleep(1000)}
  }
  if(!ready)throw new Error("authenticated staging readiness not observed")
  report.deployed = { worker: state.worker, bucket: state.bucket, url: state.url, image: QUALIFICATION_ARTIFACT.image }
  await save()
}
type Application = {id:string;name:string}
async function applications():Promise<Application[]> {
  const result=await command(["containers","list","--json","--per-page","100"])
  const value:unknown=JSON.parse(result.stdout)
  if(!Array.isArray(value) || !value.every(row=>row && typeof row.id==="string" && typeof row.name==="string"))throw new Error("container application inventory unavailable")
  return value
}
async function qualify() {
  console.log("Running model-free native tools and lifecycle qualification")
  await nativeRecord("/native/prepare"); const prepared = await pollNative("prepared")
  const receipt = prepared.receipt as { checks: Array<{passed:boolean}> }
  if (!receipt.checks.every(check => check.passed)) throw new Error("native required check failed")
  try { await nativeRecord("/native/recreate") } catch { (report.native as unknown[]).push({ action: "recreate", responseLost: true }); await save() }
  const recreated = await pollNative("recreated")
  const continuity = (recreated.receipt as {recreate:{containerContinued:boolean;markerContinued:boolean}}).recreate
  if (!continuity.containerContinued || !continuity.markerContinued) throw new Error("coordinator recreation did not preserve the native workspace")
  await nativeRecord("/native/lose"); await nativeRecord("/native/restart")
  const cleaned = await nativeRecord("/native/cleanup")
  if (!cleaned.runtimeStopped || !cleaned.cleanupRecorded) throw new Error("native cleanup unconfirmed")
  report.nativeQualified = true; await save()
}
async function evaluate(taskID: string, snapshot: Record<string, unknown>, id: string) {
  const result=await call("/evaluate/"+id,"POST",{id,taskID,files:snapshot.files},true)
  return {publicTests:{passed:result.publicTestsPassed===true},oracle:{passed:result.oraclePassed===true},runtimeStopped:result.runtimeStopped===true,receipt:result}
}
async function qualifySmokeSeams() {
  console.log("Qualifying cross-DO broker transport and isolated grading without a provider credential")
  try {
    const broker=await call("/probe/task")
    report.brokerQualification=broker;await save()
    if(broker.passed!==true || broker.externalProviderCalls!==0)throw new Error("model-free SDK/broker transport qualification failed")
    report.brokerQualified=true
  } finally {
    report.brokerQualificationCleanup=await call("/cleanup/task","POST",undefined,true);await save()
  }
  const rows:unknown[]=[];report.evaluatorQualification=rows
  for(const taskID of scope.tasks)for(const mode of ["base","reference"] as const) {
    const value=await call(`/qualify-evaluator/${mode}/${taskID}`)
    rows.push({taskID,mode,value});await save()
    if(value.publicTestsPassed!==true || value.oraclePassed!==(mode==="reference") || value.runtimeStopped!==true)throw new Error("isolated evaluator discrimination/cleanup qualification failed")
  }
  report.evaluatorQualified=true;await save()
  const prepared:unknown[]=[];report.aboiteauPreparation=prepared
  for(const taskID of scope.tasks) {
    const id=taskAttemptID(taskID,"cold",1,protocolDigest())
    const value=await call(`/aboiteau/${id}/prepare`,"POST",{id,taskID,protocolSHA256:protocolDigest(),condition:"cold",repetition:1})
    prepared.push({taskID,value});await save()
  }
  report.aboiteauPrepared=true;await save()
}
async function smoke() {
  if (!report.nativeQualified || !report.brokerQualified || !report.evaluatorQualified || !report.aboiteauPrepared) throw new Error("native, SDK/broker, evaluator and Aboiteau preparation qualification required before provider setup")
  const connection=await loadActiveConsoleCredential()
  // Credential bytes go only to the owned Worker secret API via stdin.
  await command(["secret", "bulk"], JSON.stringify({ BENCH_PROVIDER_KEY: connection.token, BENCH_PROVIDER_ORG: connection.orgID }))
  let providerReady=false
  for(let n=0;n<30;n++){
    const readiness=await call("/smoke/ready","GET",undefined,true)
    report.providerReadiness=readiness;await save()
    if(readiness.ready===true){providerReady=true;break}
    await Bun.sleep(1000)
  }
  if(!providerReady)throw new Error("provider secrets/config deployment readiness was not observed; no model cell dispatched")
  // Keep real product defaults. Its settings editor requires a repository URL;
  // this authored fixture uses the supported empty first-run workspace instead.
  // The common external dispatcher owns this smoke's $5 observation budget.
  for (const [arm, taskID] of [["opencode-harness-linux","L1"],["aboiteau","L1"],["aboiteau","Q1"],["opencode-harness-linux","Q1"]] as const) {
    const attempts = report.attempts as Array<Record<string,unknown>>
    if (attempts.some(row => row.arm === arm && row.taskID === taskID)) throw new Error("smoke cell already attempted; automatic redispatch refused")
    const id = taskAttemptID(taskID,"cold",1,protocolDigest()), body = {id,taskID,protocolSHA256:protocolDigest(),condition:"cold",repetition:1}
    const row: Record<string,unknown> = {arm,taskID,id,startedAt:new Date().toISOString(),outcome:"unknown"}; attempts.push(row); await save()
    console.log("Running paid smoke", arm, taskID)
    const base = arm === "aboiteau" ? `/aboiteau/${id}` : `/tasks/${id}`
    try {
      if (arm === "aboiteau") await call(base+"/prepare","POST",body)
      row.admission = await call(base+(arm==="aboiteau"?"/submit":""),"POST",body,true); await save()
      if((row.admission as {accepted?:boolean}).accepted!==true)throw new Error("task admission refused before execution")
      let terminal = false
      for (let n=0;n<scope.taskDeadlineMs/2000;n++) {
        const status = arm === "aboiteau" ? await call(base+"/status","GET") : await call(base+"/observe","POST")
        row.status=status
        if(n%5===0){report.providerUsage=await call("/smoke/usage","GET");await save()}
        if (arm === "aboiteau") {
          const product=status.state as {phase?:string;budgetReservation?:unknown;checkpointPending?:boolean;lastTurnError?:string;permissionNotifications?:Record<string,unknown>}
          if(Object.keys(product?.permissionNotifications??{}).length)throw new Error("native permission requires intervention outside the frozen fixture authorization; retained for review")
          if (["failed","paused"].includes(product?.phase??"")) break
          if (product?.phase==="idle" && !product.budgetReservation && !product.checkpointPending) {terminal=true;break}
        } else {
          const receipt=status.receipt as {phase?:string}
          if(receipt?.phase==="done"){terminal=true;break}
          if(["failed","ambiguous"].includes(receipt?.phase??""))break
        }
        await Bun.sleep(2000)
      }
      if (terminal) row.snapshot=await call(base+"/snapshot","GET")
      row.cleanup=await call(base+"/cleanup","POST",undefined,true); await save()
      if (terminal && (row.cleanup as {runtimeStopped?:boolean}).runtimeStopped) {
        row.checks=await evaluate(taskID,row.snapshot as Record<string,unknown>,(arm==="aboiteau"?"aboiteau-":"")+id)
        const checks=row.checks as {publicTests:{passed:boolean};oracle:{passed:boolean}}
        row.outcome=checks.publicTests.passed && checks.oracle.passed && (row.checks as {runtimeStopped:boolean}).runtimeStopped ? "accepted" : "failed"
      } else row.outcome="failed"
    } catch(error) { row.outcome="failed";row.error=error instanceof Error?error.message:"smoke operation failed";row.cleanup=await call(base+"/cleanup","POST",undefined,true).catch(()=>({runtimeStopped:false})) }
    row.finishedAt=new Date().toISOString();report.providerUsage=await call("/smoke/usage","GET");await save()
    const usage=report.providerUsage as {calls:Array<{status:string;estimatedUSD:number|null}>}
    if(usage.calls.some(call=>call.status!=="complete") || usage.calls.reduce((sum,call)=>sum+(call.estimatedUSD??0),0)>=scope.providerBudgetUSD)throw new Error("provider budget/unknown-usage gate closed")
  }
}
async function cleanup() {
  const proof: Record<string,unknown> = {}
  if(!state.deploymentAttempted && !state.bucketAttempted && !state.deployed && !state.bucketCreated) {
    report.cleanup={noMutationsAttempted:true,localControlSecretsRemoved:true};state.cleaned=true
    await save();await rm(statePath,{force:true});return
  }
  if (state.deploymentAttempted || state.deployed) {
    const preexisting=report.preexistingApplicationIDs as string[]|undefined
    if(!preexisting)throw new Error("predeployment application ownership inventory missing")
    const owned=(await applications()).filter(app=>app.name.toLowerCase().startsWith(scope.worker+"-") && !preexisting.includes(app.id))
    proof.ownedApplications=owned
    if(state.url){
    report.providerUsage=await call("/smoke/usage","GET",undefined,true).catch(()=>report.providerUsage);await save()
    proof.native=await call("/native/cleanup","POST",undefined,true).catch(()=>({runtimeStopped:false}))
    }
    // Remove every owned runtime before clearing checkpoints so no late writer
    // can repopulate the disposable bucket after its cleanup endpoint is gone.
    for(const app of owned){await command(["containers","delete",app.id],"y\n",true)}
    const stopped=await applications()
    proof.ownedApplicationsAbsent=owned.every(app=>!stopped.some(current=>current.id===app.id))
    if(!proof.ownedApplicationsAbsent)throw new Error("owned runtime deletion unconfirmed; retained Worker for cleanup retry")
    if(state.url)proof.bucket=await call("/smoke/cleanup-bucket","POST",undefined,true).catch(()=>({objectsRemaining:"unknown"}))
    const removed=await command(["delete",scope.worker,"--force"],"y\n",true); proof.workerDeleteExitCode=removed.code
    const missing=await cloud(`/workers/scripts/${scope.worker}`);proof.workerAbsent=missing.status===404
    const after=await applications()
    proof.ownedApplicationsAbsent=owned.every(app=>!after.some(current=>current.id===app.id))
    proof.preexistingApplicationsRetained=(report.preexistingApplicationIDs as string[]|undefined)?.every(id=>after.some(app=>app.id===id))??false
  }
  if(state.bucketCreated ||state.bucketAttempted){const removed=await command(["r2","bucket","delete",scope.bucket],"y\n",true);proof.bucketDeleteExitCode=removed.code;proof.bucketAbsent=(await cloud(`/r2/buckets/${scope.bucket}`)).status===404}
  state.cleaned=Boolean(proof.workerAbsent && proof.bucketAbsent && proof.ownedApplicationsAbsent && proof.preexistingApplicationsRetained);report.cleanup=proof;await save()
  if(state.cleaned){await rm(statePath,{force:true});proof.localControlSecretsRemoved=true;await writeFile(evidencePath,JSON.stringify(report,null,2)+"\n")}
  if(!state.cleaned)throw new Error("staging cleanup not fully confirmed; retained ownership state")
}

await mkdir(directory,{recursive:true})
if(await Bun.file(statePath).exists()) {
  state=JSON.parse(await readFile(statePath,"utf8"));report=JSON.parse(await readFile(evidencePath,"utf8"))
  if(state.worker!==scope.worker || state.bucket!==scope.bucket || (action!=="cleanup" && report.protocolSHA256!==protocolDigest()))throw new Error("owned scope or frozen protocol changed; retained evidence requires explicit reconciliation")
} else {
  if(await Bun.file(evidencePath).exists())throw new Error("completed or interrupted scope evidence already exists; automatic reuse refused")
  state={worker:scope.worker,bucket:scope.bucket,token:crypto.randomUUID()+crypto.randomUUID(),vault:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}
}
const config=JSON.parse(await readFile(resolve(import.meta.dir,"baseline/wrangler.template.jsonc"),"utf8"))
config.name=scope.worker;config.account_id=scope.accountID;config.main=resolve(import.meta.dir,"baseline/worker.ts");config.$schema=resolve(root,"node_modules/wrangler/config-schema.json")
config.r2_buckets[0].bucket_name=scope.bucket
for(const container of config.containers)container.images.evented.image=QUALIFICATION_ARTIFACT.image
config.vars.BENCH_TASK_CONFIG=JSON.stringify({enabled:true,protocolSHA256:protocolDigest(),spendBudgetUSD:scope.providerBudgetUSD,deadlineMs:scope.taskDeadlineMs,model:{model:scope.model,baseURL:scope.baseURL,temperature:scope.temperature,maxOutputTokens:scope.maxOutputTokens,contextTokens:scope.contextTokens,maxModelCalls:scope.maxCallsPerAttempt,requestTimeoutMs:scope.requestTimeoutMs}})
if(action!=="cleanup") {
  await writeFile(configPath,JSON.stringify(config,null,2));await save()
  report.manifest=await artifactManifest();await save()
}
try {
  if(action==="cleanup")await cleanup()
  else {
    if(!state.deployed)await deploy()
    if(action==="all" || action==="native"){await qualify();await qualifySmokeSeams()}
    if(action==="all" || action==="smoke")await smoke()
  }
} catch(error) {report.error=error instanceof Error?error.message:"live run failed";process.exitCode=1;await save();console.error(report.error)}
finally {if(action==="all")await cleanup().catch(error=>{process.exitCode=1;console.error(error.message)})}
console.log(JSON.stringify({evidence:evidencePath,nativeQualified:report.nativeQualified,attempts:(report.attempts as unknown[]).length,cleaned:state.cleaned}))
