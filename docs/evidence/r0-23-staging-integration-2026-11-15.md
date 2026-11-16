# R0-23 staging integration, 2026-11-15

The final v11 four-cell smoke passed in both arms. Earlier failures and repairs
remain retained below; the small authored smoke does not establish a winner.
[Final results and limits](r0-23-smoke-2026-11-15.md). The user selected `opencode/deepseek-v4.1-flash`
and a $5 total provider-spend budget. This does not authorize the full matrix.

## Retained failures

- [Setup 1](r0-23-live-2026-11-15.json): initial non-JSON response remains
  unclassified. Cleanup additionally exposed rejection of empty non-null POST
  streams. Cleanup of owned cloud resources was confirmed.
- [Setup 2](r0-23-live-2026-11-15-02.json): Cloudflare uploaded the Worker but
  partially applied its container settings. Cleanup was confirmed; the runner
  now bounds retries of that exact same owned deployment.
- [v6](r0-23-live-2026-11-15-03.json): 19/19 native tool checks passed, then
  coordinator recreation preserved the container and marker; explicit loss
  removed the marker on a fresh image start. The four cold smoke cells all
  failed before provider dispatch. Both baseline cells ended with unfinished
  model calls and zero tools. Both Aboiteau cells failed during construction.
- [v7](r0-23-live-2026-11-15-04.json): native and cross-DO broker qualification
  passed. The grader refused to count the known reference repair as correct,
  so the runner stopped before installing a provider credential or dispatching
  any paid cell. Cleanup was confirmed. A separate retained
  [read-only authentication failure](r0-23-v7-auth-preflight-2026-11-15.json)
  preceded this scope; refreshing the existing Wrangler session resolved it.

The original four failures remain in the smoke record. None is a model coding
accuracy observation. The broker recorded zero provider dispatches across these
runs. Actual provider invoices and infrastructure charges are not reconciled.

## Corrected v8 result

[The v8 live run](r0-23-live-2026-11-15-05.json) passed all model-free gates:
native, six synthetic cross-DO streams, all four base/reference grader cases,
and both actual Aboiteau preparations. One real baseline L1 request then
received HTTP401. The same local key also received 401 on the non-inference
catalog endpoint; there is no environment credential. The gate stopped further
dispatch with unknown usage/cost. The remaining three v8 cells are unattempted.
All owned cloud resources were verified absent and local control secrets removed.
[Authentication diagnosis](r0-23-provider-auth-2026-11-15.json).

Across versions, five failed cells remain retained and no coding success is
measured. The original reconnect conclusion was superseded: the CLI already has an
active, unexpired Chester Hill Solutions OAuth connection. It authenticates
Console configuration and the catalog with HTTP 200. The runner used an
inactive legacy key. Correct active-connection selection and workspace
forwarding before a new frozen continuation; no user re-login is needed. No winner, billing
zero, or completed four-cell v8 comparison is claimed.

## Active-session correction and v9/v10 continuation

The user questioned the reconnect diagnosis. The v2.2.7 CLI exports one active,
unexpired Chester Hill Solutions device OAuth credential. The legacy key is
explicitly inactive. Both authenticated configuration and catalogue requests
return HTTP200 with the active connection. The runner now selects that exact
active credential, validates workspace/server/expiry, and keeps refresh tokens
local. Console configuration uses `x-org-id`; its configured inference header is
`x-opencode-org-id`, which the trusted broker now forwards.

[v9](r0-23-live-2026-11-15-06.json) retained a baseline admission refusal and an
Aboiteau native request-schema refusal before provider dispatch. The native SDK
uses `max_completion_tokens`; the baseline uses `max_tokens`. Aboiteau remained
settling and normal deletion refused unresolved work. The operator stopped the
runner, retained an [intervention receipt](r0-23-v9-operator-stop-2026-11-15.json),
and verified removal of the entire owned scope. The other two cells were
unattempted. Secret-version propagation is a suspected cause of baseline
admission refusal, not a confirmed diagnosis.

v10 normalizes both field names to the same fixed 4096-token upstream limit and
observes non-secret provider/config readiness after secret installation, before
any scored admission. It fixes the optional-header TypeScript construction;
v9's runtime archive is retained, without claiming its typecheck passed.
77 tests /520 assertions, both TypeScript projects, offline bundle and the local
Workerd readiness/broker smoke pass. That corrected run later exposed interactive native permissions; v11 froze a
staging-only build shell policy retaining hard denials and completed 4/4 cells.
The total provider scope stays $5: $0.25 is withheld as a conservative allocation
for the prior inactive-key401 with unknown billing, leaving $4.75 here.

## Reproduced defects and repairs

1. Real HTTP POSTs may expose an empty stream. The native action boundary now
   reads for actual bytes with a single deadline and bounded cancellation.
2. DurableObjectBase rejects a Proxy of DurableObjectState. The staging
   subclass passes the original state; only runtime container access is wrapped
   through a protected hook. The default production implementation returns its
   original container. Six adapter checks and 34 real Worker regressions pass.
3. Workers rejects `redirect: "error"` while constructing a Request, including
   inside fetch. The baseline and broker now use `manual`, explicitly refusing
   3xx responses. A mocked redirect regression proves no follow or retry.
   This is a platform-specific defect masked by the former direct HTTP mock.
   [Cloudflare Request reference](https://developers.cloudflare.com/workers/runtime-apis/request/).
4. Bun 1.3.5's separated `--config PATH` form exited zero without running the
   requested script in this environment. Both grading commands now use one
   `--config=PATH` argument. A real Bun regression runs only trusted built-in
   fixtures: all four L1/Q1 base/reference public tests actually execute; buggy
   bases reject and repaired references emit a matching oracle pass record.

## Verification before v8

- 68 comparison tests / 471 assertions; both TypeScript projects pass.
- Real local Workerd cross-DO probe: five simulated tools, six SDK model streams,
  six completed synthetic broker usage records, six HTTP 200 handoffs, no
  refusals, zero external provider calls and confirmed local cleanup.
- Offline Wrangler binding generation and Worker bundle pass. Production
  dependencies and deployment entrypoint remain unchanged.
- v8 requires native, synthetic broker, isolated grader discrimination and
  Aboiteau preparation gates before setting the provider credential.
- Every new model cell is saved before dispatch. Failed cells are retained;
  pending or unknown broker usage blocks further provider requests. Budget is
  a scope and estimate gate, not a verified provider billing cap.

The native cancellation probe observed descendant progress after caller abort;
progress ceased after an explicit separate kill, without proving process-tree
termination. The loss probe reports portable recovery as unsupported. Neither
observation closes fault recovery, G0 or C0. Tool schemas, prompts and runtime
policy differ between the product arms, so the matched stratum remains unrated.

## Reproducible source

The root worktree is uncommitted; root HEAD alone does not identify these changes.
Each archive was checked against every source SHA in its frozen manifest:

- [v6 source](r0-23-v6-source-2026-11-15.tar.gz): 31 source inputs plus manifest;
  SHA256 `c28369bfac150e77460eeb28e26c31a5cecd192c0d0a4eef7a8f1308acdae8de`.
- [v7 source](r0-23-v7-source-2026-11-15.tar.gz): 34 source inputs plus manifest;
  SHA256 `bf964b8a0b814b3d47031d0aa71c45e2c7e1eb5b3d6acb59b2341f0b81f220b3`.
- [v8 source](r0-23-v8-source-2026-11-15.tar.gz): 34 source inputs plus manifest;
  SHA256 `48b0be3d0983ae4165a6a2873127013c722abe148c76d69c8eb6491770e70277`.

These archives contain source and dependency locks, not credentials.

## Final v11 qualification

Both arms passed L1/Q1 public tests and independent oracles. All agent/grader
runtimes stopped and all eight deployed scopes were removed, with existing apps
retained. The final 27 requests have complete usage and a $0.0542769 token-rate
estimate. Actual billing and total operating costs remain unverified.
80 comparison tests /561 assertions, both TypeScript projects and bundle pass.
The known published-rate estimates across v10/v11 sum to $0.0918564; the old
inactive-key401 retains unknown billing. All earlier failed/blocked cells remain
retained; versions are not pooled for model accuracy.

[Final per-cell evidence](r0-23-smoke-2026-11-15.md).
