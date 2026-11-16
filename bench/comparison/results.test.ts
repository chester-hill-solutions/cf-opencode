import { describe, expect, test } from "bun:test"
import { protocolDigest } from "./prepare"
import { parseAttempt, summarizeAttempts } from "./results"

const sample = () => ({schemaVersion:1,id:"observed-1",protocolSHA256:protocolDigest(),arm:"aboiteau",stratum:"product",taskID:"L1",condition:"cold",faultID:null,repetition:1,
  outcome:"accepted",oraclePassed:true,publicTestsPassed:true,sourceRevision:"synthetic-test-revision",imageDigest:"synthetic-test-image",modelIdentity:"synthetic-test-model",toolFingerprint:"synthetic-test-tools",recoveredFiles:null,duplicateEffects:0,unknownUsage:false,interventions:0,operatorSeconds:0,wallMs:100,firstOutputMs:50,modelUSD:null,containerUSD:null,storageUSD:null,receiptPaths:["synthetic-test-receipt.json"]})

describe("comparison evidence boundaries",()=>{
  test("unknown costs stay unknown while failures remain in the denominator",()=>{
    const summary=summarizeAttempts([sample(),{...sample(),id:"observed-2",repetition:2,outcome:"failed",oraclePassed:false}])
    const row=summary.strata[0]!.arms[0]!
    expect(row.recorded).toBe(2);expect(row.acceptedFraction).toBe(0.5);expect(row.unknownCostAttempts).toBe(2);expect(row.costPerAcceptedUSD).toBeNull();expect(row.missing).toBe(73)
    expect(summary.decision).toBe("unrated")
  })
  test("does not invent observations for an empty comparison",()=>{
    const summary=summarizeAttempts([]),row=summary.strata[0]!.arms[0]!
    expect(row.acceptedFraction).toBeNull();expect(row.costPerAcceptedUSD).toBeNull();expect(row.missing).toBe(75)
    expect(summary.plannedTotalAttempts).toBe(150)
    expect(summary.strata[1]!.arms[0]!.planned).toBeNull()
    expect(summary.strata[1]!.arms[0]!.missing).toBeNull()
  })
  test("refuses false acceptance, duplicate trials and a stale frozen protocol",()=>{
    expect(()=>parseAttempt({...sample(),oraclePassed:false})).toThrow("oracle")
    expect(()=>summarizeAttempts([sample(),{...sample(),id:"second-id"}])).toThrow("duplicate")
    expect(()=>parseAttempt({...sample(),protocolSHA256:"0".repeat(64)})).toThrow("frozen protocol")
  })
  test("refuses missing measurements, nonfinite costs and invalid fault attribution",()=>{
    for(const value of [{...sample(),modelUSD:NaN},{...sample(),containerUSD:undefined},{...sample(),faultID:"F1"},{...sample(),condition:"fault",faultID:"F1"}]) expect(()=>parseAttempt(value)).toThrow()
  })
})
