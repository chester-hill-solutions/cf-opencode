import { useEffect, useRef, useState } from "react"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Field,
  FieldLabel,
  Input,
  LinkButton,
  Status,
} from "@aboiteau/ui"
import type { ConversationState } from "../../src/state"
import { SiteHeader } from "../shared/site-header"
import { TokenForm } from "../shared/token-form"
import { api, readToken, rememberToken } from "../shared/api"
import { loadOverview, type Overview } from "./data"

type LoadState =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "loaded"; token: string; data: Overview; at: number }
type Inspection =
  | { kind: "empty" }
  | { kind: "loading"; key: string }
  | { kind: "loaded"; key: string; data: ConversationState }
  | { kind: "error"; key: string; message: string }
const money = (amount: number) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount)
const dateTime = (timestamp: number) =>
  new Date(timestamp).toLocaleString("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  })

export function WorkspaceApp() {
  const [token, setToken] = useState(readToken)
  const [state, setState] = useState<LoadState>({ kind: "empty" })
  const [inspection, setInspection] = useState<Inspection>({ kind: "empty" })
  const [filter, setFilter] = useState("")
  const [storageNote, setStorageNote] = useState("")
  const request = useRef<AbortController | null>(null)
  const detailRequest = useRef<AbortController | null>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const pending = state.kind === "loading"
  const data = state.kind === "loaded" && state.token === token.trim() ? state.data : null
  const conversations = data?.conversations.kind === "ready" ? data.conversations.data : null
  const usage = data?.usage.kind === "ready" ? data.usage.data : null
  const bothFailed = data?.conversations.kind === "error" && data.usage.kind === "error"

  async function load(value = token) {
    if (!value.trim()) return
    request.current?.abort()
    detailRequest.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setState({ kind: "loading" })
    setInspection({ kind: "empty" })
    const next = await loadOverview(
      value.trim(),
      AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
    )
    if (controller.signal.aborted) return
    setState({
      kind: "loaded",
      token: value.trim(),
      data: next,
      at: Date.now(),
    })
    if (
      (next.usage.kind === "ready" || next.conversations.kind === "ready") &&
      !rememberToken(value.trim())
    ) {
      setStorageNote("Browser storage is unavailable. Enter your token again next time.")
    }
  }

  async function inspect(key: string) {
    detailRequest.current?.abort()
    const controller = new AbortController()
    detailRequest.current = controller
    setInspection({ kind: "loading", key })
    try {
      const next = await api<ConversationState>(
        token.trim(),
        `/api/conversations/${encodeURIComponent(key)}`,
        {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        }
      )
      if (
        !next ||
        typeof next !== "object" ||
        !Array.isArray(next.seen) ||
        !next.pending ||
        typeof next.pending !== "object"
      )
        throw new Error("The conversation state could not be read. Try inspecting again.")
      if (!controller.signal.aborted) setInspection({ kind: "loaded", key, data: next })
    } catch (cause) {
      if (!controller.signal.aborted)
        setInspection({
          kind: "error",
          key,
          message: cause instanceof Error ? cause.message : "Conversation unavailable. Try again.",
        })
    }
  }

  useEffect(() => {
    const value = readToken()
    if (value) void load(value)
    return () => {
      request.current?.abort()
      detailRequest.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (inspection.kind !== "empty") detailHeading.current?.focus()
  }, [inspection.kind === "empty" ? "" : inspection.key])

  return (
    <>
      <SiteHeader page="workspace" />
      <main id="main" className="content-layout workspace-layout">
        <div className="page-heading">
          <p className="eyebrow">Your deployment / At a glance</p>
          <h1>Room to work.</h1>
          <p className="lead">
            Reported usage and known conversations, straight from your deployment.
          </p>
        </div>
        <section className="settings-section token-section" aria-labelledby="workspace-connect">
          <div className="section-heading">
            <div>
              <h2 id="workspace-connect">Connect your workspace</h2>
              <p>Use the same API token as setup and settings.</p>
            </div>
          </div>
          <TokenForm
            token={token}
            setToken={(value) => {
              request.current?.abort()
              detailRequest.current?.abort()
              setToken(value)
              setState({ kind: "empty" })
              setInspection({ kind: "empty" })
            }}
            pending={pending}
            connect={() => void load()}
            label={data ? "Refresh workspace" : "Connect workspace"}
          />
          {storageNote && (
            <p role="status" className="connection-note">
              {storageNote}
            </p>
          )}
        </section>
        <div className="overview-status" role="status">
          <Status
            tone={
              pending
                ? "busy"
                : bothFailed
                  ? "error"
                  : data
                    ? usage && conversations
                      ? "success"
                      : "warning"
                    : "neutral"
            }
          >
            {pending
              ? "Loading workspace…"
              : bothFailed
                ? "Connection unavailable"
                : data
                  ? usage && conversations
                    ? "Connected"
                    : "Partially available"
                  : "Not connected"}
          </Status>
          {state.kind === "loaded" && data && (
            <span>Last checked {dateTime(state.at)}. Refresh for updates.</span>
          )}
        </div>
        {pending && <p className="loading-panel">Loading usage and conversations…</p>}
        {data && (
          <>
            <section className="overview-section" aria-labelledby="usage-heading">
              <div className="overview-section-heading">
                <div>
                  <p className="eyebrow">01 / Usage</p>
                  <h2 id="usage-heading">Today’s reported usage</h2>
                </div>
                <LinkButton href="/settings/#model-runtime" variant="outline">
                  Manage limits
                </LinkButton>
              </div>
              {data.usage.kind === "error" ? (
                <Alert variant="destructive">
                  <AlertTitle>Usage unavailable</AlertTitle>
                  <AlertDescription>{data.usage.message}</AlertDescription>
                </Alert>
              ) : (
                usage && (
                  <>
                    <p className="section-description">
                      {usage.date} · UTC day · All amounts in USD
                    </p>
                    <dl className="usage-grid">
                      <div>
                        <dt>Reported spend</dt>
                        <dd>{money(usage.costUSD)}</dd>
                      </div>
                      <div>
                        <dt>Reserved for turns</dt>
                        <dd>{money(usage.reservedUSD)}</dd>
                      </div>
                      <div>
                        <dt>Admitted total</dt>
                        <dd>{money(usage.admittedUSD)}</dd>
                      </div>
                      <div>
                        <dt>Daily admission budget</dt>
                        <dd>{usage.budgetUSD === 0 ? "No limit" : money(usage.budgetUSD)}</dd>
                      </div>
                    </dl>
                    <p className="connection-note">
                      Reported spend and reservations are separate. The daily budget gates new
                      turns; an admitted turn can exceed it.
                    </p>
                    {usage.historicalUsageUnreconciled && (
                      <Alert className="setup-notice">
                        <AlertTitle>Some usage remains unreconciled</AlertTitle>
                        <AlertDescription>
                          Reported totals may be incomplete. Unknown costs are not zero.
                          {usage.unknownReconciliationCount
                            ? ` ${usage.unknownReconciliationCount} unknown reconciliation receipt(s) recorded.`
                            : ""}
                        </AlertDescription>
                      </Alert>
                    )}
                  </>
                )
              )}
            </section>
            <section className="overview-section" aria-labelledby="conversations-heading">
              <div className="overview-section-heading">
                <div>
                  <p className="eyebrow">02 / Conversations</p>
                  <h2 id="conversations-heading">Pick up the thread.</h2>
                </div>
                {conversations && <Status>{conversations.length} known</Status>}
              </div>
              {data.conversations.kind === "error" ? (
                <Alert variant="destructive">
                  <AlertTitle>Conversations unavailable</AlertTitle>
                  <AlertDescription>{data.conversations.message}</AlertDescription>
                </Alert>
              ) : (
                conversations && (
                  <>
                    {!conversations.length ? (
                      <div className="empty-panel">
                        <h3>No conversations yet</h3>
                        <p>
                          After setup, send a DM or mention Aboiteau in a Slack thread on a
                          deployment with Slack configured. Conversations started over the API
                          appear here too.
                        </p>
                        <LinkButton href="/onboarding/" variant="outline">
                          Review setup
                        </LinkButton>
                      </div>
                    ) : (
                      <>
                        <Field className="conversation-filter">
                          <FieldLabel htmlFor="conversation-filter">Find a conversation</FieldLabel>
                          <Input
                            id="conversation-filter"
                            type="search"
                            value={filter}
                            onChange={(event) => setFilter(event.target.value)}
                            placeholder="Filter by conversation key"
                          />
                        </Field>
                        <ul className="conversation-list">
                          {conversations
                            .filter((item) => item.key.toLowerCase().includes(filter.toLowerCase()))
                            .map((item) => (
                              <li key={item.key}>
                                <div>
                                  <strong>{item.key}</strong>
                                  <span>Last API activity {dateTime(item.lastSeenAt)}</span>
                                </div>
                                <Button
                                  variant="outline"
                                  onPress={() => void inspect(item.key)}
                                  pending={
                                    inspection.kind === "loading" && inspection.key === item.key
                                  }
                                  pendingLabel="Inspecting…"
                                >
                                  Inspect
                                </Button>
                              </li>
                            ))}
                        </ul>
                        {!conversations.some((item) =>
                          item.key.toLowerCase().includes(filter.toLowerCase())
                        ) && (
                          <p className="empty-panel" role="status">
                            No conversations match “{filter}”. Clear the search to see all
                            conversations.
                          </p>
                        )}
                        <p className="connection-note">
                          This is the conversation registry, not a live activity list. Inspecting a
                          conversation records API activity; it does not start a turn.
                        </p>
                      </>
                    )}
                  </>
                )
              )}
            </section>
          </>
        )}
        {data && inspection.kind !== "empty" && (
          <section
            className="settings-section inspection-panel"
            aria-labelledby="inspection-heading"
          >
            <h2 ref={detailHeading} tabIndex={-1} id="inspection-heading">
              Conversation details
            </h2>
            <p className="conversation-key">{inspection.key}</p>
            {inspection.kind === "loading" && <p role="status">Reading conversation state…</p>}
            {inspection.kind === "error" && (
              <Alert variant="destructive">
                <AlertTitle>Could not inspect conversation</AlertTitle>
                <AlertDescription>{inspection.message}</AlertDescription>
              </Alert>
            )}
            {inspection.kind === "loaded" && (
              <>
                <Status>{inspection.data.phase ?? "idle"}</Status>
                <dl className="inspection-grid">
                  <div>
                    <dt>Session</dt>
                    <dd>{inspection.data.sessionID ?? "Not started"}</dd>
                  </div>
                  <div>
                    <dt>Queued messages</dt>
                    <dd>{inspection.data.queue?.length ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Pending approvals</dt>
                    <dd>{Object.keys(inspection.data.pending).length}</dd>
                  </div>
                  <div>
                    <dt>Last checkpoint</dt>
                    <dd>
                      {inspection.data.checkpointManifest
                        ? dateTime(inspection.data.checkpointManifest.createdAt)
                        : "Not recorded"}
                    </dd>
                  </div>
                </dl>
                {inspection.data.lastTurnError && (
                  <p className="field-error">Last turn: {inspection.data.lastTurnError}</p>
                )}
                {inspection.data.settlementError && (
                  <p className="field-error">Settlement: {inspection.data.settlementError}</p>
                )}
                <p className="connection-note">
                  Continue the conversation and answer approvals in its original Slack thread or API
                  client.
                </p>
              </>
            )}
            <div className="setup-actions">
              <Button variant="outline" onPress={() => void inspect(inspection.key)}>
                Refresh details
              </Button>
              <Button
                variant="ghost"
                onPress={() => {
                  detailRequest.current?.abort()
                  setInspection({ kind: "empty" })
                }}
              >
                Close details
              </Button>
            </div>
          </section>
        )}
        {!data && !pending && (
          <p className="connection-note">
            New here? <a href="/onboarding/">Connect a provider and repository first →</a>
          </p>
        )}
      </main>
    </>
  )
}
