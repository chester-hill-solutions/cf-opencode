import { faults, protocol, tasks } from "./protocol"
import { protocolDigest } from "./prepare"

export interface Attempt {
  schemaVersion: 1
  id: string
  protocolSHA256: string
  arm: "aboiteau" | "opencode-harness-linux"
  stratum: "product" | "matched"
  taskID: string
  condition: "cold" | "warm" | "fault"
  faultID: string | null
  repetition: number
  outcome: "accepted" | "failed" | "refused" | "unsupported" | "timeout"
  oraclePassed: boolean
  publicTestsPassed: boolean
  sourceRevision: string
  imageDigest: string
  modelIdentity: string
  toolFingerprint: string
  recoveredFiles: boolean | null
  duplicateEffects: number | null
  unknownUsage: boolean
  interventions: number
  operatorSeconds: number
  wallMs: number
  firstOutputMs: number | null
  modelUSD: number | null
  containerUSD: number | null
  storageUSD: number | null
  receiptPaths: string[]
}

const outcomes = ["accepted","failed","refused","unsupported","timeout"]
const isAmount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
const record = (value: unknown): value is Record<string,unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Validate evidence shape. This does not independently prove the asserted runtime facts. */
export function parseAttempt(value: unknown): Attempt {
  if (!record(value) || value.schemaVersion !== 1 || value.protocolSHA256 !== protocolDigest()) throw new Error("attempt does not match frozen protocol")
  if (!protocol.arms.includes(value.arm as Attempt["arm"]) || !["product","matched"].includes(String(value.stratum)) || !outcomes.includes(String(value.outcome))) throw new Error("invalid arm/stratum/outcome")
  const task=tasks.find(task=>task.id===value.taskID)
  if(!task || !["cold","warm","fault"].includes(String(value.condition)) || !Number.isInteger(value.repetition) || Number(value.repetition)<1 || Number(value.repetition)>3) throw new Error("invalid task or trial identity")
  if(value.condition==="fault") { if(!faults.some(fault=>fault.id===value.faultID && fault.task===value.taskID)) throw new Error("fault/task mismatch") }
  else if(value.faultID!==null) throw new Error("ordinary trial cannot carry fault")
  for(const key of ["id","sourceRevision","imageDigest","modelIdentity","toolFingerprint"] as const) if(typeof value[key]!=="string" || !value[key] || /[\r\n]/.test(value[key])) throw new Error("missing artifact/attempt identity: "+key)
  for(const key of ["oraclePassed","publicTestsPassed","unknownUsage"] as const) if(typeof value[key]!=="boolean") throw new Error("missing observation: "+key)
  for(const key of ["wallMs","operatorSeconds","interventions"] as const) if(!isAmount(value[key])) throw new Error("invalid measured quantity: "+key)
  for(const key of ["firstOutputMs","modelUSD","containerUSD","storageUSD","duplicateEffects"] as const) if(value[key]!==null && !isAmount(value[key])) throw new Error("unknown must be null; invalid quantity: "+key)
  if(!Number.isInteger(value.interventions) || (value.duplicateEffects!==null && !Number.isInteger(value.duplicateEffects))) throw new Error("counts must be integers")
  if(value.recoveredFiles!==null && typeof value.recoveredFiles!=="boolean") throw new Error("invalid recovery observation")
  if(!Array.isArray(value.receiptPaths) || !value.receiptPaths.length || !value.receiptPaths.every(path=>typeof path==="string" && path.length>0)) throw new Error("runtime receipt references required")
  if(value.outcome==="accepted" && (!value.oraclePassed || !value.publicTestsPassed)) throw new Error("accepted task requires independent oracle and public tests")
  return {
    schemaVersion:1, id:String(value.id), protocolSHA256:String(value.protocolSHA256),
    arm:value.arm as Attempt["arm"], stratum:value.stratum as Attempt["stratum"], taskID:task.id,
    condition:value.condition as Attempt["condition"], faultID:value.faultID as string|null, repetition:Number(value.repetition),
    outcome:value.outcome as Attempt["outcome"], oraclePassed:Boolean(value.oraclePassed), publicTestsPassed:Boolean(value.publicTestsPassed),
    sourceRevision:String(value.sourceRevision), imageDigest:String(value.imageDigest), modelIdentity:String(value.modelIdentity), toolFingerprint:String(value.toolFingerprint),
    recoveredFiles:value.recoveredFiles as boolean|null, duplicateEffects:value.duplicateEffects as number|null, unknownUsage:Boolean(value.unknownUsage),
    interventions:Number(value.interventions), operatorSeconds:Number(value.operatorSeconds), wallMs:Number(value.wallMs),
    firstOutputMs:value.firstOutputMs as number|null, modelUSD:value.modelUSD as number|null, containerUSD:value.containerUSD as number|null, storageUSD:value.storageUSD as number|null,
    receiptPaths:value.receiptPaths as string[],
  }
}

export function summarizeAttempts(values: unknown[]) {
  const attempts=values.map(parseAttempt), ids=new Set<string>(), cells=new Set<string>()
  for(const attempt of attempts) {
    const cell=JSON.stringify([attempt.stratum,attempt.arm,attempt.taskID,attempt.condition,attempt.faultID,attempt.repetition])
    if(ids.has(attempt.id) || cells.has(cell)) throw new Error("duplicate attempt/trial: preserve retries inside one attempt receipt")
    ids.add(attempt.id); cells.add(cell)
  }
  const plannedPerArm=tasks.length*protocol.repetitions.ordinary*protocol.repetitions.conditions.length + faults.length*protocol.repetitions.faults
  const strata=["product","matched"].map(stratum=>({stratum,arms:protocol.arms.map(arm=>{
    const rows=attempts.filter(row=>row.stratum===stratum && row.arm===arm), accepted=rows.filter(row=>row.outcome==="accepted").length
    const unknownCost=rows.filter(row=>row.modelUSD===null || row.containerUSD===null || row.storageUSD===null).length
    const knownCostUSD=rows.reduce((sum,row)=>sum+(row.modelUSD??0)+(row.containerUSD??0)+(row.storageUSD??0),0)
    const planned=stratum==="product"?plannedPerArm:null
    return {arm,planned,recorded:rows.length,missing:planned===null?null:planned-rows.length,accepted,acceptedFraction:rows.length?accepted/rows.length:null,
      outcomes:Object.fromEntries(outcomes.map(outcome=>[outcome,rows.filter(row=>row.outcome===outcome).length])),knownCostUSD,unknownCostAttempts:unknownCost,costPerAcceptedUSD:accepted && !unknownCost?knownCostUSD/accepted:null,
      unknownEffectsAttempts:rows.filter(row=>row.duplicateEffects===null).length,observedDuplicateEffects:rows.reduce((sum,row)=>sum+(row.duplicateEffects??0),0),unknownUsageAttempts:rows.filter(row=>row.unknownUsage).length,
      interventions:rows.reduce((sum,row)=>sum+row.interventions,0),operatorSeconds:rows.reduce((sum,row)=>sum+row.operatorSeconds,0)}
  })}))
  return {schemaVersion:1,kind:"comparison-observations",protocolSHA256:protocolDigest(),plannedTotalAttempts:plannedPerArm*protocol.arms.length,strata,decision:"unrated",reason:"The product matrix is planned; matched-stratum counts remain undefined until equivalence is qualified. Observed shapes are not runtime qualification; require paired artifact/equivalence and fault evidence plus review against frozen thresholds."}
}
