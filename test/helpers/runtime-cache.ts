import type { ContainerPort } from "../../src/opencode"

export interface RuntimeCacheHarness {
  readonly ready: boolean
  readonly apiPort?: ContainerPort
  readonly generation?: string
  readonly eventPersistence?: boolean
  readonly eventPersistenceGeneration?: string
  readonly startMode: "image" | "snapshot" | "none"
  readonly inactivitySet: boolean
  readonly imageVariant?: "base" | "evented"
  markVerified(port: ContainerPort, generation: string, eventPersistence: boolean): void
  recordGeneration(generation: string): void
  recordProof(generation: string, eventPersistence: boolean): void
  bindImage(variant: "base" | "evented" | undefined): void
  pauseServer(): void
  invalidate(): void
  resetAfterStop(): void
  applyInactivity(container: { setInactivityTimeout(ms: number): Promise<void> }): void
}

export function runtimeCache(instance: unknown): RuntimeCacheHarness {
  return (instance as { runtime: RuntimeCacheHarness }).runtime
}
