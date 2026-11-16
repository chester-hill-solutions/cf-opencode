#!/usr/bin/env bun
import { artifactManifest, materialize, selfcheck } from "./prepare"
import { summarizeAttempts } from "./results"
import { fixtureFiles } from "./fixtures"
import { tasks } from "./protocol"

const [action,arg1,arg2]=process.argv.slice(2)
if(action==="selfcheck") console.log(JSON.stringify(await selfcheck(),null,2))
else if(action==="manifest") console.log(JSON.stringify(await artifactManifest(),null,2))
else if(action==="summary" && arg1) {
  const rows=(await Bun.file(arg1).text()).split("\n").filter(line=>line.trim()).map(line=>JSON.parse(line))
  console.log(JSON.stringify(summarizeAttempts(rows),null,2))
} else if(action==="prepare" && arg1 && arg2) {
  const task=tasks.find(task=>task.id===arg1)
  if(!task || !(task.repo in fixtureFiles)) throw new Error("unknown task")
  const commit=await materialize(task.repo,arg2)
  console.log(JSON.stringify({taskID:task.id,repo:task.repo,baseCommit:commit,prompt:task.prompt,publicCheck:"bun test",privateOracle:"Run trusted oracle outside the agent checkout; never send referenceFiles/oracle.ts to the agent."},null,2))
} else {
  console.error("usage: bun bench/comparison/cli.ts selfcheck | manifest | prepare TASK EMPTY_DIR | summary ATTEMPTS.jsonl")
  process.exitCode=2
}
