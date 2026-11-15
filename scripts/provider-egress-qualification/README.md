# R1-7a provider-egress qualification

This is a bounded staging fixture for the native outbound-traffic boundary. It
uses the pinned evented image and explicit 1 vCPU / 2 GiB / 8 GB instance, starts
the container with `enableInternet: false`, and intercepts only HTTP for the
fixed host `provider.aboiteau`. A fixed WorkerEntrypoint returns synthetic
OpenAI-compatible JSON and SSE responses. It never fetches a real provider.

## Credentials and isolation

Use a newly deployed, disposable staging Worker with a fresh isolated DO
namespace in the approved account. Bind no production resources.
Set `API_TOKEN` as a Worker secret. Set `PROVIDER_PROXY_API_KEY` as a second
Worker secret to a synthetic value beginning `R1_7A_UPSTREAM_` and containing
at least 32 additional characters. Do not use a real provider key. The upstream
secret remains in WorkerEntrypoint scope and is never placed in the container,
OpenCode config, probe environment, receipts, or logs. The separate per-run
`prx_…` grant token is intentionally confined to the fixture DO and its local
OpenCode config/probe.

The only public operations are authenticated empty-body `POST /prepare`,
`POST /verify`, and `POST /cleanup`. They address the fixed DO name `R1-7A` and
fixed model `r1-7a-probe`; they expose no command, path, host, model, or proxy
controls. `prepare` and `verify` each accept one attempt per fixed DO; replay
returns 409 even after a successful stage. Cleanup is repeatable and retains a
nonsecret attempt tombstone. A failed or ambiguous preparation or verification
should be cleaned up; the rehearsal needs a fresh deployed DO namespace to
retry.

## Rehearsal

1. Copy this JSONC template to a private staging config, set its
   approved Cloudflare account id and pinned image digest, and bind a fresh
   namespace.
2. Set the two synthetic secrets above. Keep the Worker and its namespace
   isolated from production resources.
3. Call `POST /prepare`, then `POST /verify`, and save only the allowlisted
   response booleans, fixed image/model identifiers, and artifact hashes.
4. Call `POST /cleanup`. Accept cleanup only when the runtime is confirmed
   stopped and the fixture has forgotten its transient grant and control token.
   The 30-minute alarm and five-minute native inactivity timeout are cleanup
   safeguards, not billing ceilings. If cleanup cannot confirm destruction,
   keep the disposable staging resource isolated and force-delete it through
   the provider control plane.

`/verify` creates a fresh OpenCode session and sends a fixed marker prompt using
the SDK with queue delivery. It requires a terminal assistant reply with that
marker, exercises fixed JSON and SSE calls from the agent uid, checks invalid
route/token/model cases, attempts direct HTTP/HTTPS/TCP egress, and scans a
bounded `/state-checkpoint` archive. The archive must contain the scoped proxy
token and provider id, proving the config was captured, while containing
neither the synthetic upstream key nor its marker prefix. Probe and archive
contents are held in Worker memory and discarded.
Only booleans, observed counts, a fixed model/image, and measured hashes
may leave the fixture.

A passing live receipt qualifies the pinned image/runtime's native interception
path and the tested
credential-disclosure boundary for the synthetic case. It does not establish
tenant-isolated R2 behavior, production credential provisioning, production
default internet policy, arbitrary application-code confinement, or a
general-purpose proxy guarantee. It does not repeat the separate native-CI
conversation-state-seed negative case.

## Offline preflight

`bun scripts/provider-egress-qualification/build-probe.ts` compiles the fixed
container probe into ignored `.wrangler/provider-egress-preflight` output.
`bun scripts/provider-egress-qualification/preflight.ts` generates types and
runs Wrangler's local dry-run bundler with an all-zero account id. It does not
create resources or deploy anything.
