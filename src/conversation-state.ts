/**
 * The per-conversation record and its phase machine.
 *
 * Split from `ConversationStore` so the shape can change (and be versioned)
 * without the storage implementation in the same file. Everything here is a
 * type or a pure transition rule; importing it from `state.ts` keeps working.
 */

import type { WorkspaceRepositoryBinding } from "./workspace-repository"
import type { TurnKey, TurnRecord } from "./turns"

export type Transport = "slack" | "http"

/**
 * Persisted conversation lifecycle. Execution guards (`pumping`, `streaming`)
 * stay in memory; this is the state a restarted DO can reason about.
 */
export type ConversationPhase = "idle" | "admitting" | "running" | "settling" | "queued"

/** Current shape of the stored record. Bump with a migration, never silently. */
export const STATE_VERSION = 1

/**
 * Fields that describe the record rather than the conversation's history.
 * Guards that refuse "a conversation that has run before" must ignore them,
 * or every metadata field would look like evidence of prior work.
 */
export const STATE_METADATA_FIELDS = ["stateVersion"] as const

/** Target phase → phases it may be entered from. */
export const ALLOWED_FROM: Record<ConversationPhase, ConversationPhase[]> = {
  idle: ["idle", "admitting", "running", "settling", "queued"],
  admitting: ["idle", "queued"],
  running: ["admitting", "queued", "running"],
  settling: ["running", "admitting"],
  queued: ["idle", "admitting"],
}

export function canTransition(from: ConversationPhase, to: ConversationPhase): boolean {
  return ALLOWED_FROM[to].includes(from)
}

export interface SlackTarget {
  channel: string
  /** Thread root replies are posted under. Absent for DMs. */
  replyTs?: string
}

/** One admission held while the container could not accept it. */
export interface QueuedMessage {
  /** Stable owner fence for its Lifecycle admission/retry intent. */
  id: string
  /** Stable FIFO ordering timestamp. */
  enqueuedAt: number
  /** Original admission transport. */
  source: Transport
  text: string
  /** Optional request id used to return the same pending queue receipt. */
  idempotencyKey?: string
  /** Turn this entry will become once dispatched. */
  turnID?: string
  slack?: SlackTarget
  attempts: number
  /** When the next admission attempt is due. */
  nextAttemptAt?: number
  /** Why the last attempt failed, for operators. */
  lastError?: string
}

/** Legacy singleton queue shape accepted only while normalizing stored records. */
export interface LegacyQueuedMessage extends Partial<Pick<QueuedMessage, "id" | "enqueuedAt" | "source">> {
  text: string
  idempotencyKey?: string
  slack?: SlackTarget
  attempts: number
  nextAttemptAt?: number
  lastError?: string
}

export type QueueEnqueueResult =
  | { kind: "enqueued"; id: string; position: number; depth: number; limit: number }
  | { kind: "queue_full" | "admission_in_progress"; depth: number; limit: number }

/** Durable reference to the one Settings-owned hold for this conversation. */
export interface BudgetReservation {
  reservationID: string
  /** UTC day assigned by Settings when the hold was first granted. */
  date?: string
  /** True once the provider request may have been sent. */
  dispatched: boolean
}

export interface OperatorReconciliationMarker {
  receiptID: string
  reservationID: string
  kind: "observed_actual" | "acknowledged_unknown"
  createdAt: number
  usageDate: string | null
  actualCostUSD: number | null
}

export interface CheckpointPart {
  key: string
  size: number
  encrypted: boolean
}

/** A split checkpoint: workspace and harness state are separate R2 objects. */
export interface CheckpointManifest {
  workspace: CheckpointPart
  state?: CheckpointPart
  /** Workspace fingerprint at archive time. */
  fingerprint?: string
  /** State fingerprint at archive time. */
  stateFingerprint?: string
  createdAt: number
}

export interface PermissionNotification {
  sessionID: string
  delivered: boolean
  attempts: number
  nextAttemptAt: number
}

export interface ConversationState {
  /** Shape this record was written with; absent on records that predate it. */
  stateVersion?: typeof STATE_VERSION
  /** Opt-in immutable task identity; global defaults never overwrite it. */
  workspaceRepository?: WorkspaceRepositoryBinding
  /** Lifecycle phase; absent means "idle" for conversations from older builds. */
  phase?: ConversationPhase
  /** When the current run was admitted, for turn-duration metrics. */
  runStartedAt?: number
  /** How many times this conversation started a container, for ops visibility. */
  containerStarts?: number
  /** Last assistant message id before the current prompt; the turn boundary. */
  turnBaseline?: string
  /** Turn whose run the settle path currently owns. */
  turnID?: string
  /** Bounded newest-last caller-facing turn records. */
  turns?: TurnRecord[]
  /** Idempotency keys inside their replay window. */
  turnKeys?: Record<string, TurnKey>
  sessionID?: string
  /** A model choice local to this conversation, preserved across cold starts. */
  modelOverride?: string
  /** Channel threads accept follow-ups after a mention, until !leave. */
  slackEngaged?: boolean
  /** Provenance for pre-work Slack controls; legacy seen/history is never adopted. */
  slackControlHistory?: {
    schemaVersion: 1
    kind: "benign_only"
    events: Array<{ id: string; command: BenignSlackControlCommand }>
  }
  /** Questions already announced for the active session. */
  announcedForms?: string[]
  transport?: Transport
  slack?: SlackTarget
  /** Last assistant text broadcast to SSE, used to avoid duplicates. */
  lastReply?: string
  /** Last assistant text posted to Slack; interim updates stay on SSE only. */
  lastSlackReply?: string
  /** Key of the turn failure already reported, for at-most-once delivery. */
  reportedError?: string
  /** Settings version the running container was configured with. */
  settingsVersion?: number
  /** Authoritative FIFO of pending admissions. */
  queue?: QueuedMessage[]
  /** @deprecated Legacy persisted singleton; normalized away on read. */
  queued?: LegacyQueuedMessage
  /** Stable fence for a pre-dispatch admission recovery wake. */
  admissionID?: string
  /** When the current admission claimed the phase, for stale recovery. */
  admissionStartedAt?: number
  /** Owned Settings hold for the current turn, if one has been acquired. */
  budgetReservation?: BudgetReservation
  /** Durable local pointer to the last acknowledged operator reconciliation receipt. */
  operatorReconciliation?: OperatorReconciliationMarker
  /** Fingerprint of the workspace at the last successful checkpoint. */
  checkpointFingerprint?: string
  /** Fingerprint of the state root at the last successful checkpoint. */
  checkpointStateFingerprint?: string
  /** R2 key of the last successful checkpoint, used to prove a 204 is real. */
  checkpointKey?: string
  /** Split checkpoint: both archive keys and their verified sizes. */
  checkpointManifest?: CheckpointManifest
  /** The stored archive is application-encrypted with the tenant key. */
  checkpointEncrypted?: boolean
  /** A checkpoint failed and has not been retried to success. */
  checkpointPending?: boolean
  /** Retry count for a pending checkpoint. */
  checkpointAttempts?: number
  /** Earliest safe retry time for a failed checkpoint. */
  checkpointRetryAt?: number
  /** Last bounded lifecycle callback failure, retained for operator visibility. */
  lifecycleJobError?: { kind: string; message: string; at: number }
  /** Alarm memory-limit seal: resume requires guarded recovery retry or reset. */
  lifecycleJobsSealed?: boolean
  /** Size of the last successful checkpoint, for cost tracking. */
  checkpointSize?: number
  /** The terminal error of the last turn, kept for status output. */
  lastTurnError?: string
  /** Legacy cumulative spend snapshot; durable usage sources supersede it. */
  usage?: { date: string; costUSD: number; input: number; output: number }
  /** Highest acknowledged durable session log sequence for this session. */
  usageCursor?: { sessionID: string; seq: number }
  /** Latest acknowledged billable step for terminal settlement proof. */
  usageTerminal?: { sessionID: string; assistantMessageID: string; seq: number }
  /** Latest durable execution fences observed while replaying this session. */
  usageExecution?: { sessionID: string; startedSeq: number; terminalSeq: number; latestStepSeq: number }
  /** Why the last usage refresh failed, for operators. */
  usageError?: string
  /** Why terminal settlement is paused, or why a closed turn keeps its reservation. */
  settlementError?: string
  closedTurn?: { at: number; reason: "session_missing" | "settlement_expired"; sessionID?: string }
  /** Slack event ids already handled (dedupe). */
  seen: string[]
  /** Pending permission requests: requestID -> sessionID. */
  pending: Record<string, string>
  /** Delivery acknowledgement/backoff, independent of permission ownership. */
  permissionNotifications?: Record<string, PermissionNotification>
}

const benignSlackControls = ["help", "status", "usage", "setup", "connect", "repo", "check", "checks", "workspace"] as const
export type BenignSlackControlCommand = typeof benignSlackControls[number]
export function benignSlackControlCommand(name: string): BenignSlackControlCommand | undefined {
  return benignSlackControls.find(command => command === name)
}
