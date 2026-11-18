/**
 * Aboiteau's golden profile catalogue.
 *
 * Vendored from `@chester-hill-solutions/ratchet-strap` 0.7.2
 * (`house-rules/golden.mjs`), because 0.7 ships the mechanism and the twelve
 * open-source defaults but no profile catalogue: each repository owns its
 * enabled set. Rule definitions are unchanged from the starter. Only
 * `enabledProfiles` below is local policy.
 */
const consumer = (detector) => ({ kind: "consumer", detector });
const contract = (id) => ({ kind: "contract", id });
const review = (anchor) => ({ kind: "review", anchor });
const ratchet = (rule) => ({ kind: "ratchet", rule });

export const goldenProfiles = Object.freeze({
    typescript: Object.freeze([
      Object.freeze({
        id: "ts.strict",
        title: "Strict compiler",
        rule: "TypeScript projects enable strict, noUncheckedIndexedAccess, noImplicitOverride and noImplicitReturns.",
        enforcement: [consumer("the project's TypeScript configuration gate")],
      }),
      Object.freeze({
        id: "ts.no-escape",
        title: "No silent type escapes",
        rule: "No @ts-ignore or @ts-nocheck in active code; @ts-expect-error carries a description; `as any` and `as unknown as` are ratcheted.",
        enforcement: [consumer("a type-escape scanner or compiler gate")],
      }),
    ]),
    react: Object.freeze([
      Object.freeze({
        id: "react.state-machine",
        title: "Explicit state machines",
        rule: "Lifecycle state changes go through a named event reducer or transition table; no literal state setters.",
        enforcement: [consumer("a lifecycle-state scanner")],
      }),
      Object.freeze({
        id: "react.effects",
        title: "No bare effects",
        rule: "Every useEffect or useLayoutEffect documents its purpose, dependencies, side effects and why it cannot be a loader, fetcher or derived value — or is marked CANDIDATE-REMOVE.",
        enforcement: [consumer("an effects-strictness scanner")],
      }),
    ]),
    "react-router": Object.freeze([
      Object.freeze({
        id: "router.loaders",
        title: "Loaders and actions first",
        rule: "Data loading and mutation go through loaders, actions or fetchers; an effect must justify why it cannot.",
        enforcement: [consumer("the route and effect checks")],
      }),
      Object.freeze({
        id: "router.authorization",
        title: "Route authorization",
        rule: "Membership and role checks go through the route's typed middleware or handler factory; no ad-hoc inline authentication.",
        enforcement: [consumer("the route authorization checks")],
      }),
      Object.freeze({
        id: "router.request-integrity",
        title: "Request integrity",
        rule: "A request body is consumed once, and signed webhooks verify their signature before processing.",
        enforcement: [consumer("the request-body and webhook checks")],
      }),
    ]),
    web: Object.freeze([
      Object.freeze({
        id: "web.client-bundle",
        title: "Client bundle purity",
        rule: "Built client assets contain no server module, database import or credential marker.",
        enforcement: [consumer("a client-bundle scanner")],
      }),
    ]),
    ui: Object.freeze([
      Object.freeze({
        id: "ui.design-system",
        title: "Use the design system",
        rule: "Build from the consumer's design system and tokens; do not hand-roll styles or components the system already provides.",
        enforcement: [consumer("the consumer's design review or registry check")],
      }),
    ]),
    quality: Object.freeze([
      Object.freeze({
        id: "quality.duplication",
        title: "Duplication ceilings",
        rule: "Clone and duplicated-line counts stay at or below the reviewed ceilings.",
        enforcement: [consumer("a jscpd-style duplication scan")],
      }),
      Object.freeze({
        id: "quality.file-size",
        title: "File-size ceilings",
        rule: "No file grows past its reviewed line ceiling.",
        enforcement: [consumer("a file-size scan")],
      }),
      Object.freeze({
        id: "quality.async-sequencing",
        title: "Explicit async sequencing",
        rule: "Sequential awaits and repeated awaits in loops are explicit and reviewed; dependency and callback boundaries stay visible.",
        enforcement: [consumer("an async-sequencing scan")],
      }),
      Object.freeze({
        id: "quality.test-signal",
        title: "Honest test signals",
        rule: "Tests use the real dependency, await a signal instead of a sleep or poll, run once, keep their declared timeout, and fail on unhandled network requests.",
        enforcement: [consumer("the chs-testing-honesty@1 ESLint policy")],
      }),
    ]),
    telemetry: Object.freeze([
      Object.freeze({
        id: "telemetry.boundaries",
        title: "Telemetry boundaries",
        rule: "Every production effect boundary is observed or recorded; no unobserved error reporting.",
        enforcement: [consumer("a telemetry-boundary scanner")],
      }),
    ]),
    release: Object.freeze([
      Object.freeze({
        id: "release.versioned",
        title: "Versioned releases",
        rule: "A published change carries a version bump and a changelog line.",
        enforcement: [consumer("the consumer's release gate")],
      }),
      Object.freeze({
        id: "release.adr",
        title: "Format changes need ADRs",
        rule: "A format change ships an ADR, a dual-read window and a rollback.",
        enforcement: [consumer("the consumer's ADR review")],
      }),
    ]),
    /**
     * The CHS Vault guardrails. RatchetStrap 0.6 shipped this profile in the
     * package catalogue; 0.7 moved opinionated profiles to the consumer, and
     * Aboiteau is the consumer that implements Vault, so it is vendored here
     * unchanged from 0.6.2.
     */
    vault: Object.freeze([
      Object.freeze({
        id: "G1",
        title: "Ciphertext-only storage",
        rule: "Nothing but versioned ciphertext reaches a VaultStore.",
        enforcement: [],
        pending: "VLT-01",
      }),
      Object.freeze({
        id: "G2",
        title: "No secret values in outputs",
        rule: "No secret value appears in a response, log, span attribute or error message. The redactSecrets contract proves the redactor works, not the absence of leaks from every output path.",
        enforcement: [contract("vault.redact.invariant")],
      }),
      Object.freeze({
        id: "G3",
        title: "Workspace identity is bound",
        rule: "Workspace identity is bound, never passed by the caller.",
        enforcement: [review("workspace-identity-is-bound")],
      }),
      Object.freeze({
        id: "G4",
        title: "User-facing surfaces are write-only",
        rule: "User-facing surfaces are write-only.",
        enforcement: [review("user-facing-surfaces-are-write-only")],
      }),
      Object.freeze({
        id: "G5",
        title: "Every credential read is audited",
        rule: "Every credential read is audited, or refused.",
        enforcement: [],
        pending: "AUD-07",
      }),
      Object.freeze({
        id: "G6",
        title: "Credentials are verified before promotion",
        rule: "A credential is never promoted unverified.",
        enforcement: [],
        pending: "CAT-09",
      }),
      Object.freeze({
        id: "G7",
        title: "Verification is read-only",
        rule: "Verification never mutates the provider.",
        enforcement: [contract("catalog.verify.invariant")],
      }),
      Object.freeze({
        id: "G8",
        title: "Ciphertext is identity-bound",
        rule: "Ciphertext is bound to its identity (workspace + key).",
        enforcement: [],
        pending: "CRY-09",
      }),
      Object.freeze({
        id: "G9",
        title: "Baselines only shrink",
        rule: "A baseline may only shrink.",
        enforcement: [contract("ratchet.writeBaseline.invariant")],
      }),
      Object.freeze({
        id: "G10",
        title: "Vault has no Node builtins or auth dependency",
        rule: "vault has no Node builtins and no dependency on auth.",
        enforcement: [ratchet("no-restricted-imports"), ratchet("no-restricted-globals")],
      }),
      Object.freeze({
        id: "G11",
        title: "Published changes are versioned and documented",
        rule: "A published change carries a version bump and a changelog line.",
        enforcement: [review("published-package-version-bumps")],
      }),
      Object.freeze({
        id: "G12",
        title: "Erasure is cryptographic",
        rule: "Erasure is cryptographic wherever we claim deletion.",
        enforcement: [],
        pending: "CRY-08",
      }),
      Object.freeze({
        id: "G13",
        title: "Format changes require an ADR",
        rule: "A format change ships an ADR, a dual-read window and a rollback.",
        enforcement: [review("format-change-requires-an-adr")],
      }),
    ]),
 });

/**
 * The profiles this repository enables. RatchetStrap 0.7 ships no enabled set,
 * so this is ours: a profile that does not fit Aboiteau's stack stays out, and
 * `tests/golden-profiles.test.ts` refuses an enabled profile it has not mapped.
 */
export const enabledProfiles = Object.freeze([
  "typescript",
  "react",
  "web",
  "ui",
  "quality",
  "telemetry",
  "vault",
]);
