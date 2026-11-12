type StopSignal = "SIGTERM" | "SIGKILL"

export type LifecycleTask<T = unknown> = () => T | Promise<T>
export type LifecycleGate = <T>(operation: LifecycleTask<T>) => Promise<T>

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** A FIFO asynchronous gate; rejected operations do not poison later work. */
export function createLifecycleGate(): LifecycleGate {
  let tail: Promise<void> = Promise.resolve()
  return function run<T>(operation: LifecycleTask<T>): Promise<T> {
    const result = tail.then(operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}

type ChildProcessLike = {
  readonly exitCode: number | null
  readonly exited: Promise<unknown>
  kill(signal?: StopSignal): unknown
}

/** Stop a child only after its exit is observable; retain the handle on failure. */
export async function stopChild<T extends ChildProcessLike>(
  child: T | undefined,
  operation: string,
): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  const afterTerm = await Promise.race([
    child.exited.then(() => true),
    delay(2_000).then(() => false),
  ])
  if (afterTerm) return
  child.kill("SIGKILL")
  const afterKill = await Promise.race([
    child.exited.then(() => true),
    delay(2_000).then(() => false),
  ])
  if (!afterKill) throw new Error(`${operation} process could not be stopped`)
}
