import { fixtureFiles } from "../fixtures"
import { tasks } from "../protocol"
import type { LinuxToolPlane } from "./linux"

export const taskRoot = "/workspace/r0-23"

/** Only base fixture files are copied. Reference repairs and oracles stay outside. */
export async function prepareTaskWorkspace(taskID: string, id: string, plane: LinuxToolPlane, signal: AbortSignal): Promise<string> {
  const task = tasks.find(task => task.id === taskID)
  if (!task || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/.test(id)) throw new Error("invalid task workspace identity")
  await plane.execute("shell", { command: "test -z \"$(ls -A)\" && mkdir -p src test" }, signal)
  for (const [path, content] of Object.entries(fixtureFiles[task.repo])) await plane.execute("write", { path, content }, signal)
  // Same fixed Git identities/dates as prepare.ts; no host user config or hooks.
  const command = "export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_DATE=2026-11-14T12:00:00Z GIT_COMMITTER_DATE=2026-11-14T12:00:00Z; " +
    "git init --quiet --initial-branch=main && git add . && git -c user.name='R0-23 Fixture' -c user.email=fixture@example.invalid -c core.hooksPath=/dev/null commit --quiet -m 'Frozen R0-23 base fixture' && git rev-parse HEAD"
  const commit = (await plane.execute("shell", { command }, signal)).trim()
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("fixture commit missing")
  await plane.execute("write", { path: ".r0-23-attempt", content: id }, signal)
  return commit
}

/** Bounded export is an observation; it does not prove descendant quiescence. */
export const snapshotCommand = "bun -e '" + String.raw`
const fs=await import("node:fs/promises"),path=await import("node:path");
const files={};let count=0,bytes=0;
async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){
 const p=path.join(dir,entry.name);if(p===".git"||p===".r0-23-attempt")continue;
 if(entry.isSymbolicLink())throw new Error("snapshot symlink refused");
 if(entry.isDirectory()){await walk(p);continue;}
 if(!entry.isFile()||++count>64)throw new Error("snapshot file limit");
 const size=(await fs.stat(p)).size;if(size>65536||(bytes+=size)>40000)throw new Error("snapshot byte limit");
 files[p]=await fs.readFile(p,"utf8");
}}
await walk(".");process.stdout.write(JSON.stringify({files,quiescence:"unproven"}));
` + "'"
