# Harness base toolchain

What the coding container ships by default, and what it deliberately does not.
Decisions here are product decisions: an agent that lacks a tool will spend turns
discovering that, and one that has the wrong tools will spend turns installing.

## Tier 1 — always present

| Tool | Why |
|---|---|
| `git`, `gh`, `git-lfs` | clone, branch, PR; LFS because repositories surprise you |
| `bun`, `bunx`, `node`, `npm`, `npx` | all three runtimes. `npx` is an egress dependency, not a default path |
| `python3`, `uv` | `uv` instead of `pip`; resolver failures are a flail generator |
| `jq`, `yq` | JSON and YAML without writing a script |
| `ripgrep`, `fd`, `tree`, `less`, `file` | navigation; `rg` is the largest single time saver |
| `curl`, `wget`, `openssl`, `ca-certificates` | HTTP and TLS debugging |
| `tar`, `gzip`, `xz`, `zstd`, `zip`, `unzip` | archives |
| `make`, `gcc`, `g++`, `pkg-config` | native node modules fail to build without them |
| `sqlite3` | inspect local databases and tool state |
| `coreutils`, `findutils`, `procps`, `diffutils` | baseline gaps in slim images |

## Tier 2 — domain-relevant, cheap

- `python3-openpyxl`, `csvkit` — SMS/report exports land as XLSX and CSV.
- `shellcheck` — catch broken generated scripts before the user runs them.
- `psql` client only where database work is expected.

## Tier 3 — deliberately absent

- `aws-cli` (heavy; `stow-s3` already ships). Add per profile when AWS work is declared.
- `docker`, `kubectl`, `terraform` — task-specific.
- Language SDKs beyond Node and Python — installed per profile.

## Principles

1. **Versions are stated, not guessed.** Pin at build and expose through the
   capability manifest (`harness context`), so the prompt can name real versions.
   A hardcoded list in prose drifts the moment the image changes.
2. **Assert in CI.** A check runs `command -v` for every promised tool and fails
   the build if one disappears. Otherwise "fixed toolset" is a claim the agent
   discovers is false at the worst moment.
3. **`npx` is not a critical path.** Preinstall CLIs the harness depends on;
   `npx` only works while the registry is reachable.
4. **Missing tool means report, not install.** The workspace brief already says
   so; the image should make that rare rather than make it the routine.
