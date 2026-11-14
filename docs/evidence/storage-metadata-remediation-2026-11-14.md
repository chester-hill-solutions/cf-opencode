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
CI and corrected live qualification are pending; R0-15 remains open.
