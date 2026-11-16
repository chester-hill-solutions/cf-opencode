import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fixtureFiles, referenceFiles, type FixtureID } from "./fixtures"
import { protocol, tasks } from "./protocol"
import { QUALIFICATION_ARTIFACT } from "../../scripts/native-storage-qualification/artifact"

export const digest = (value: string) => createHash("sha256").update(value).digest("hex")
export const fixtureDigest = (id: FixtureID) => digest(JSON.stringify(fixtureFiles[id]))
const frozenInputs=["fixtures.ts","protocol.ts","oracle.ts","prepare.ts","results.ts","cli.ts","live.ts","operator-credential.ts","baseline/preflight.ts","baseline/local-smoke.ts","baseline/wrangler.local.json","baseline/worker.ts","baseline/linux.ts","baseline/provider.ts","baseline/journal.ts","baseline/task-model.ts","baseline/task-plugin.ts","baseline/task-request.ts","baseline/task-workspace.ts","baseline/task-worker.ts","baseline/task-runtime.ts","baseline/task-probe.ts","baseline/evaluator.ts","baseline/native-qualification.ts","baseline/native-checks.ts","baseline/aboiteau-arm.ts","baseline/smoke-provider.ts","baseline/smoke-contract.ts","baseline/smoke-scope.ts","baseline/package.json","baseline/bun.lock","baseline/wrangler.template.jsonc","../../src/control-auth.ts","../../src/conversation.ts","../../src/conversation/event-stream.ts"]
export const protocolDigest = () => digest(JSON.stringify({protocol,nativeArtifact:QUALIFICATION_ARTIFACT,sources:Object.fromEntries(frozenInputs.map(path=>[path,digest(readFileSync(resolve(import.meta.dir,path),"utf8"))]))}))

async function command(argv: string[], cwd: string): Promise<{ code: number; output: string }> {
  const child=Bun.spawn(argv,{cwd,stdout:"pipe",stderr:"pipe",env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_DATE:"2026-11-14T12:00:00Z",GIT_COMMITTER_DATE:"2026-11-14T12:00:00Z"}})
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
  return {code,output:out+err}
}

export async function materialize(id: FixtureID, destination: string): Promise<string> {
  await mkdir(destination,{recursive:true})
  if ((await readdir(destination)).length) throw new Error("fixture destination must be empty")
  for (const [path,content] of Object.entries(fixtureFiles[id])) { const target=join(destination,path); await mkdir(dirname(target),{recursive:true}); await writeFile(target,content) }
  for (const args of [["init","--quiet","--initial-branch=main"],["add","."],["-c","user.name=R0-23 Fixture","-c","user.email=fixture@example.invalid","-c","core.hooksPath=/dev/null","commit","--quiet","-m","Frozen R0-23 base fixture"]]) {
    const result=await command(["git",...args],destination); if(result.code!==0) throw new Error(result.output)
  }
  return (await command(["git","rev-parse","HEAD"],destination)).output.trim()
}

export async function selfcheck() {
  const root=await mkdtemp(join(tmpdir(),"aboiteau-r0-23-"))
  const observed: Array<{taskID:string;baseRejected:boolean;referencePassed:boolean}>=[]
  const commits: Record<string,string>={}
  try {
    for(const id of ["ledger","queue"] as const) {
      const baseline=join(root,id,"base"), reference=join(root,id,"reference")
      commits[id]=await materialize(id,baseline); const second=await materialize(id,reference)
      if(second!==commits[id]) throw new Error("fixture Git commits are not reproducible")
      for(const [path,content] of Object.entries(referenceFiles[id])) await writeFile(join(reference,path),content)
      for(const directory of [baseline,reference]) {const result=await command([process.execPath,"test"],directory);if(result.code!==0) throw new Error("public fixture regressions failed: "+result.output)}
      for(const task of tasks.filter(task=>task.repo===id)) {
        const base=await command([process.execPath,resolve(import.meta.dir,"oracle.ts"),task.id,baseline],root)
        const repaired=await command([process.execPath,resolve(import.meta.dir,"oracle.ts"),task.id,reference],root)
        if(base.code===0 || repaired.code!==0) throw new Error(task.id+" oracle discrimination failed: "+JSON.stringify({base,repaired}))
        observed.push({taskID:task.id,baseRejected:true,referencePassed:true})
      }
    }
    return {schemaVersion:1,kind:"local-oracle-selfcheck",protocolSHA256:protocolDigest(),platform:process.platform,arch:process.arch,bun:Bun.version,fixtureCommits:commits,fixtureSHA256:{ledger:fixtureDigest("ledger"),queue:fixtureDigest("queue")},observed,providerCalls:0,modelEffectiveness:"unmeasured"}
  } finally { await rm(root,{recursive:true,force:true}) }
}

export async function artifactManifest() {
  const sources:Record<string,string>={}
  for(const path of frozenInputs) sources[path]=digest(await readFile(resolve(import.meta.dir,path),"utf8"))
  return {schemaVersion:1,kind:"prepared-comparison",protocolSHA256:protocolDigest(),fixtureSHA256:{ledger:fixtureDigest("ledger"),queue:fixtureDigest("queue")},sourceSHA256:sources,nativeArtifact:QUALIFICATION_ARTIFACT,baselineDependencies:JSON.parse(await readFile(resolve(import.meta.dir,"baseline/package.json"),"utf8")).dependencies,protocol,executionReady:false,blockedBy:["native Linux tools and lifecycle await live qualification","four-attempt paid smoke awaits execution and cleanup receipts","full matrix and fault-injection qualification remain outside this smoke"],measuredAttempts:[]}
}
