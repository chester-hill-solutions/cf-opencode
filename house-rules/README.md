# House rules

RatchetStrap 0.7 ships the mechanism and the twelve open-source defaults
(`U1`–`U12`); profiles, thresholds and the enabled set belong to the consuming
repository. This directory is that record for Aboiteau.

| File | Contents |
| --- | --- |
| `golden.mjs` | The nine opt-in profiles, vendored from RatchetStrap 0.7.2, plus the set this repository enables. |
| `golden.d.mts` | Types so the coverage gate can import the catalogue from TypeScript. |

ESLint thresholds stay in [`eslint.config.mjs`](../eslint.config.mjs)
(`RATCHET_RULES`) because the flat config consumes them directly; they are not
copied here.

`tests/golden-profiles.test.ts` fails when a profile rule arrives without an
owner, when an enabled profile has no local evidence, or when the catalogue and
the repository's coverage drift apart. Upgrade RatchetStrap by re-copying
`node_modules/@chester-hill-solutions/ratchet-strap/house-rules/golden.mjs` and
reviewing the diff, not by importing the package's copy.
