# R1-7a first provider-egress slice — 2026-11-14

This receipt covers the scoped provider forwarder and its fixed native
qualification fixture. The roadmap §5.5 remains the scheduling authority.

## Implemented

`ProviderEgress` is a named Worker entrypoint. Its authority comes from trusted
binding props: conversation identity, one model, token hash and expiration.
Only POST JSON to the exact internal `provider.aboiteau` chat-completions path is
accepted. Requests are bounded to 1 MiB, decoded and model-checked, then rebuilt
as canonical JSON. The only upstream is the fixed OpenAI HTTPS chat-completions
URL. Client headers cannot supply provider credentials or an alternate route.
The Worker injects its credential; redirects are manual and error bodies/headers
are replaced with generic responses. Successful JSON/SSE bodies stream through.

Grants contain 256 random bits and expire after 15 minutes. Expiry is checked
again after body consumption. Malformed Worker credentials fail generically
before header construction. A custom installed OpenCode provider receives the
scoped token and internal base URL; the upstream key is not a configuration or
container-probe input.

The fixture starts the current source-pinned image with public Internet disabled
and exactly one native HTTP intercept. It uses a synthetic upstream implemented
inside the Worker, so no real provider inference is required. It measures the
controller and Stow hashes, uses the authenticated control proxy, and requires
a completed assistant reply from a real OpenCode SDK turn. An agent-UID probe
covers JSON/SSE, negative authorization/routing, direct network attempts,
repository-controlled code, readable state and same-UID process environments.
A bounded portable state archive must contain the scoped configuration and must
not contain the upstream sentinel. Expired/mismatched grants and upstream outage
are tested by fixed rebindings; restoring the valid binding requires a positive
request before qualification can pass.

Preparation and verification are one-shot. Cleanup preserves only a nonsecret
attempt tombstone after confirmed destruction and forgets capabilities. A
30-minute alarm, capped retry interval and five-minute native inactivity timeout
support cleanup; the caller must force-delete an uncertain resource through the
provider control plane. These are operational safeguards, not billing ceilings.

## Reuse and review

The implementation uses the platform pattern from Cloudflare's
[runner outbound handler](https://github.com/cloudflare/sandbox-sdk/blob/main/examples/coding-agents/runner/outbound.ts)
(inspected blob `9cb80650360b188a3dcb431fd08ee3310a47685a`) and Exo's
[pinned network adapter](https://github.com/exoharness/exo/blob/1eeab021a854dc8db502d82b9fe656cbaf044671/exoharness/cloudflare/src/network.ts):
trusted entrypoints inject credentials after sandbox requests leave, with
identity supplied separately and redirects controlled. This prototype adds the
single-provider grant/model policy and proof harness; it adds no proxy daemon,
runtime replacement or parallel production dispatcher.

Three persistent Luna contexts implemented protocol, config/probe and fixture
work. Parent and cross-owner review resolved concrete false-proof cases:
partial scans, inverted negative-result checks, treating external HTTP errors as
network denial, unconfirmed route restoration and cached-pass reuse. The fixed
receipt rejects missing/incomplete evidence, unsupported state entries and
unreadable extant same-UID environments. Request canonicalization also removes
duplicate-model parser ambiguity.

## Local verification

- Full typecheck passed, including the new qualification project.
- Configuration agreement and UI build passed.
- Bun: **465 passed**, plus **5 runtime tests passed**.
- Worker/DO: **370 passed in 63 files** using isolated synthetic bindings.
- Offline fixture gate passed: receipt/scan tests, generated types and Wrangler
  dry-run with an all-zero account. CI now runs that offline bundling check.
- An initial full Worker run failed an existing sealed-recovery test's exact job
  count (two rows versus one). The focused case and four-test file passed, then
  the full 370-test suite passed without product changes or weaker assertions.
  The extra job was not identified; startup/alarm interleaving is unconfirmed.

Native CI and live qualification are recorded separately for their tested
revision. No Docker daemon, production deployment or real model call was used
for the local results above.

## Remaining boundaries

A live native receipt is required to establish the tested network interception
and credential-disclosure observations. Mocks and a bundle do not establish it.
Production activation requires credential provisioning/migration, scoped grant
issuance/renewal/revocation through the existing turn authority, and restore
handling. Git and package egress, OAuth, tenant isolation and the OpenCode
self-approval residual remain separate R1-7a/R1-7 work. The deployed legacy
credential path remains known-open G1 until that work is completed. C0 and all
product/security gates remain open.
