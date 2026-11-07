/// <reference types="@cloudflare/vitest-plugin/types" />
import type { Env as WorkerEnv } from "../src/env"

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {}
