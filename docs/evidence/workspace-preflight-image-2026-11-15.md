# Workspace preflight image retry — 2026-11-15

**Result: sequential full smoke PASSED after a resource-profile correction.** The initial retry built the image and reached 22 intermediate `ok` checkpoints, then exited **1** at `seeded recipient native readiness failed`. A reduced control supported emulated-host memory pressure; the full retry with one active runtime at a time passed every assertion. The original failure and subsequent receipts remain below. This qualifies the captured preflight image's local sequential path, with the limits in the final section.

## Exact run and artifact

```sh
IMAGE=aboiteau-preflight:20261115 bash scripts/smoke-container.sh > /tmp/aboiteau-preflight-container-retry.log 2>&1
```

- Run began approximately `2026-11-15T18:07:30Z`; failure/cleanup observed by `18:13:08Z`.
- Source HEAD: `ec5f6b44f1457ab9b8bc7e600b169ac3e9c7d1b2`, with uncommitted preflight changes. The hashes below identify relevant build-context files; HEAD alone does not identify this image.
- Docker **24.0.6**, daemon **aarch64**, target **linux/amd64**, using emulation. This is not a native amd64 CI result.
- Image: `sha256:25e3dd01997e9c5acd7273d425b7d662a50e3da0c328d90e61fae8865b5b17b9`; size **493,022,493 bytes** (script reports 470 MB); created `2026-11-15T18:09:29.394972382Z`.
- Initial free space: host approximately **27 GiB**; Docker filesystem **18,952,236 KiB** (>8 GiB). Docker daemon health was checked using nonempty server version/architecture, not its misleading sandbox-denied zero-valued response.
- Build context transfer completed before later product work was released to proceed. This receipt covers this captured image, not subsequent repository-binding implementation.

| Build-context file | SHA-256 captured before build |
|---|---|
| `Dockerfile` | `80ceac2a0979ae47443eee3bf0f2383cc2b42afb6de881bc23eb16df89b3e7cf` |
| `control-server.ts` | `799fc06808cd7e1f3087c933386c3c35ed6cbfdeb1cb68eaaf38b302fc8a6230` |
| `workspace-preflight.ts` | `53c82e31486de625ab6c299a9560b55aacfc5d5f4ef9efef3e76e085431b25df` |
| `src/workspace-preflight.ts` | `a5af1639e09379a869f7bb4dba92b9dce1033de77c9c1d8145dcd9dfdda7909b` |
| `scripts/smoke-container.sh` | `e46eb641cd9bf472d36348b89848a06f3529478958a8d7271bc17e9dd0657d9b` |

## Observed scope and failure

The new authenticated preflight ran **before runtime startup** and retained its read-only/unverified response contract without changing runtime readiness. Earlier checks also passed normal OpenCode/Stow readiness, the pinned Stow binary, file/S3 round trips, split checkpoints/restores, escaping-symlink refusal, missing-registry fail-closed behavior and account-seed archive separation.

The seeded-recipient process probe then reported:

```json
{"readinessValid":true,"opencodeProcessCount":0,"stowProcessCount":1,"opencodeAgentUID":false,"stowAgentUID":true,"opencodeS3EnvironmentMatchesReadiness":false,"opencodeProcessIdentityMatches":false,"stowProcessIdentityMatches":true,"stowProcessUsesPinnedBinary":true,"kernelExecutableMatchesExpected":true,"expectedKernelExecutable":"/usr/bin/qemu-x86_64"}
```

This records the failed assertion, not a diagnosed root cause. The subsequent streamed restore/reseed and fresh-container cold-recovery checks were not completed. Dockerfile's deliberate pre-patch Stow regression failure occurred earlier as an expected red/green build check and is distinct from this smoke failure.

## Cleanup and limits

The script's exit trap removed both owned smoke containers; final `docker ps -a` showed no smoke containers. Existing `deploy-studio-1` remained container `8fd750f3c29aa01548a2232abc129a5edf9dc42b11f5ec1ae8fec06b65ead0e9`, running with start time `2026-11-15T17:58:45.608984542Z`; `http://127.0.0.1:8791` returned **200** afterward. The built local image is retained.

Raw log: `/tmp/aboiteau-preflight-container-retry.log`, SHA-256 `627e2305ccc3b11dc5c15aeccabbbc3c8977884549d8aa4280da22ee8a849e27`. No provider inference, deployment, publication or frozen Cloudflare artifact-pin edits were performed by this verification task. No Cloudflare/R2 durability or coding-task claim follows from this local emulated run.

## Bounded diagnosis after the failure

The diagnose workflow used this existing image, two disposable source/recipient containers, synthetic account state and the existing streamed seed/start race. No rebuild or product-code change was made. The first reduced two-active-runtime attempt stopped earlier than the full-smoke failure: its pre-seed Docker process observer timed out after 60 seconds. The source container nevertheless recorded `OOMKilled=true`. Its receipts are in `/tmp/aboiteau-seed-diag-88693-1794766532`; this is supporting resource evidence, not reproduction of the exact original assertion.

Four hypotheses were ranked before controls: VM memory pressure, process-probe/QEMU mismatch, post-readiness lifecycle exit, and seeded-state incompatibility. The single-variable control stopped the owned source container after generating the archive and before starting the recipient. That run **passed** (`/tmp/aboiteau-seed-diag-94857-1794766734`): seed and start HTTP 200, full accounting/event-persistence start proof, native process probe exactly one OpenCode/one Stow with matching UID/environment, and `/status` running plus proxied `/api/info` 200 immediately and after approximately two/seven seconds. Recipient `oom`/`oom_kill` counters were zero; both containers reported `OOMKilled=false`.

Docker VM memory was **4,124,282,880 bytes**. The isolated recipient reported memory.current **2,516,877,312 bytes**, peak **3,511,107,584 bytes**, and OpenCode RSS **1,431,260 KiB**. This strongly supports memory pressure with two emulated runtimes, while the passing isolated seed control argues against an unconditional seed incompatibility or process-probe mismatch. The original full-smoke failure did not capture its OOM counter, so its precise cause remains unproven and the full image gate remains open. No resource settings, assertions or permissions were changed. Both diagnosis runs' owned containers were cleaned up.

## Sequential-memory full retry — passed

Within the authorized image verification, the smoke harness stopped its owned source after all source archives/identity checks and removed its completed recipient before creating the cold-restore runtime. Every existing assertion remained. This qualifies **sequential recovery**, not concurrent capacity. `scripts/smoke-container.sh` SHA-256 became `6de7028978c95f5052ed6c555abdab10fad48ee4c03b4dd1fe7a655742846cea`.

The same command with log `/tmp/aboiteau-preflight-container-sequential.log` exited **0** and printed `container smoke test passed`. Image identity remained exactly `sha256:25e3dd01997e9c5acd7273d425b7d662a50e3da0c328d90e61fae8865b5b17b9` (493,022,493 bytes). The previously unreached account-seed native readiness, distinct recipient identity, streamed seed/restore lifecycle serialization, reseed refusal and fresh-container split recovery all passed. The original failed attempt remains recorded above.

Final container inventory showed only preserved `deploy-studio-1` running (same ID, uptime approximately 30 minutes); no owned smoke containers remained. Sequential log SHA-256: `8582e34034f8f47b34895fabc3797f3c4999d05752ee7c23ab0b19005f3a4270`. This remains emulated local Linux evidence for the preflight image, not native amd64 CI, bound-repository qualification, provider inference or Cloudflare/R2 evidence.
