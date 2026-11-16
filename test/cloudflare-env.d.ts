/// <reference types="@cloudflare/vitest-plugin/types" />
import type { Env as WorkerEnv } from "../src/env"
import type { LifecycleProbe } from "./fixtures/lifecycle-host"

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./fixtures/worker")
      durableNamespaces: "Conversation" | "Settings" | "LifecycleProbe"
    }
    interface Env extends WorkerEnv {
      LIFECYCLE_PROBE: DurableObjectNamespace<LifecycleProbe>
    }
  }
}

export {}
