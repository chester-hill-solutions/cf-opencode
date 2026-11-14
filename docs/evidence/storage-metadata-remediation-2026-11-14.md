# R0-15 metadata remediation — 2026-11-14

The initial live matrix recorded successful PUT with missing Cache-Control,
Content-Disposition and Content-Encoding on HEAD. In source-pinned Stow v0.4.0
(`3bb3e890bbe56f11dd783c2ccfb9bd2813156919`), the HTTP handlers only pass content
type and user metadata into storage. The three properties are absent from the
object model. This selects the handler/model hypothesis; response-only repair
cannot recover values never persisted.

The downstream patch in [patches/stow](../../patches/stow/README.md) returns typed
S3 `501 NotImplemented` on object writes/copies and multipart initiation carrying
these properties, before storage mutation. It retains existing supported read,
write and multipart paths and changes no stored format. This is the declared
R0-15 safe-refusal alternative, not full metadata persistence support.

The new SDK regression failed on the unmodified release for all three headers:
`want typed 501 NotImplemented, got <nil>`. After the patch, the complete S3 API
package passed (11.6 s, Go 1.25.6, macOS ARM64, two workers). The same test asserts
refusal of new writes, overwrites, copy/replace and multipart initiation, retained
original bytes/metadata/validator/timestamp, and unchanged object/upload inventory.
An initial focused run accidentally used the patched source because a reset
command used the wrong working-directory-relative path; it is not counted as the
baseline. The corrected source reset produced the expected three baseline failures.

The linux/amd64 CGO-disabled candidate built with Go 1.25.6, trimpath, stripped
symbols and build VCS disabled has SHA256
`78e69bb95cef92433543ac339fa9a38ffc3a8d4b66173820a776a097e3e5ed0b`.
Docker now builds from a checksum-verified source archive and digest-pinned Go
builder, proves the baseline failure, applies the patch and runs the S3 API tests.
Native CI must independently verify that reproducible binary hash and the full
consumer gate. No neighbouring Stow working-tree files were modified.

The [cutover runbook](../runbooks/storage-cutover.md) names retained data and
intentional resets (none). It is prepared input, not production approval. Native
CI and corrected live qualification subsequently passed; production cutover and
the remaining R0-15 obligations remain open (results below).


## Selector hardening follow-up

Final review found that `?uploadId` or `?partNumber` alone can fall through the
released multipart dispatcher to ordinary PutObject. The initial guard excluded
those selectors, allowing unsupported metadata to bypass refusal. The final guard
covers every PUT plus multipart initiation. Nine direct HTTP regressions cover all
three headers with partial and complete selector pairs and verify empty object
inventory after typed refusal. The complete S3 API package passed again (10.9 s).
The final linux/amd64 candidate SHA256 is
`39615975e58008a60a94b0c696e9ee46aa8dba77e1899e5297dcb4f5010e3174`.
The earlier `78e69bb9…` candidate is superseded and is not the final live target.


## Final verification

Final fix commit `fa5411bd93092fd102fb65d4d69c0562712d6fa0` is pushed to the
existing branch. [Native CI 43643079964](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43643079964)
passed both jobs: type/config/UI checks, 412 Bun tests, 5 runtime tests, all 351
Worker/DO tests, and native container smoke. The native image independently
matched the final `39615975…` binary hash. The complete native S3 API package,
including selector regressions, passed after proving the original failure.
[Structured CI receipt](storage-metadata-native-ci-2026-11-14.json). Earlier
busy-host failures remain recorded; this native run resolves the regression gate.

The final image was assembled without local Docker using checksum-verified
`crane` 0.22.1 from its official release: the frozen 0.4.0 base plus exactly one
layer replacing `/usr/local/bin/stow-s3` with the independently hash-matched binary.
Runtime config values and the entire base layer prefix were read back and matched.
Crane omitted an empty/null `OnBuild` config key; no runtime value changed.
Final image:
`registry.cloudflare.com/ad5ec479b9a421faa2ed06c3d1c2b23a/cf-opencode-metadata-candidate@sha256:4fe5c456f39903be5cbba5027a5d00f1961ac37fb63c7e6a3493c09af2903f24`.
The source/patch/binary/image pins are in `artifact.ts`; receipts explicitly label
this downstream build `metadata-refusal.2` rather than claiming an upstream release.

The corrected [live Cloudflare/R2 receipt](storage-metadata-live-2026-11-14.json)
reports **17/17 accepted outcomes: 14 preserved, 3 refused before mutation, zero
failed or unexercised**. Unsupported metadata returned 501 before creating an
object or altering workspace/registry bytes; the absent object remained absent
after recovery. The two registry faults returned 409/503 without mutation.
Keys, multipart completion, Git, imported history and the active-writer recovery
point passed after encrypted R2-only recovery, with stable identity and no snapshot.
The active capture took 2.441 s, within the 30-second writer lifetime, with no
quiesced retry. Workspace/state archives were 14,780 / 943,792 bytes.

`metadataTypeMatches: false` is expected in this receipt because the complete
unsupported metadata PUT was refused and that object never existed. Supported
content type and user metadata round trips remain covered by native S3 API tests;
this is not evidence that the three unsupported properties are now persisted.

The fixed matrix is one synthetic run, not throughput, arbitrary-writer or
production-cutover qualification. Native smoke also passed account-seed identity,
ephemeral credential exclusions and fresh-recipient tests; a live account-seed
rehearsal and production rollout inventory/approval remain R0-15 work. The
[cutover runbook](../runbooks/storage-cutover.md) retains operator data and resets
none. Actual billed cost remains unknown; no product/security gate was closed.

Temporary Worker, container application, bucket and private test-secret files
were removed after the run. The superseded intermediate image tag is removed;
the qualified candidate tag is retained. The earlier failed live receipt and
historical 0.3.7 evidence remain unchanged.
