# Stow 0.4.0 metadata refusal

This downstream patch fixes the R0-15 live finding in
[the original receipt](../../docs/evidence/storage-matrix-2026-11-14.json).
The released HTTP handlers only carry content type and user metadata into the
object model. Cache-Control, Content-Disposition and Content-Encoding were
acknowledged but discarded.

Until native storage represents those properties, reject their presence on
PutObject, CopyObject and CreateMultipartUpload with S3 `501 NotImplemented`,
before storage mutation. Supported writes/reads and multipart parts without these headers retain their
existing paths. This adds no storage format and migrates no operator data.
It does not add full S3 metadata support.

The source is immutable v0.4.0 commit
`3bb3e890bbe56f11dd783c2ccfb9bd2813156919`, with archive SHA256
`387c91bcf9f9a4ac2691fbf980885ccfb88e6eaf7b3732681e75a2eca2b1adc8`.
The Docker build uses a digest-pinned Go 1.25.6 builder, verifies the archive,
proves the SDK regression fails for the expected reason before applying the
patch, then runs the complete S3 API package tests after applying it. The SDK
regression checks typed refusals, unchanged existing bytes/metadata/validator,
absence of a new object, and absence of an initiated multipart upload. Malformed
multipart selectors are covered explicitly: every PUT carrying these unsupported
properties is refused, so a partial selector cannot fall through to PutObject.

This patch is carried in cf-opencode so its candidate can be built without
altering the neighbouring Stow checkout's unrelated changes. It is not an
upstream Stow release. Remove the downstream patch only after an upstream
release provides the same refusal or full persistence/response contract and the
replacement passes R0-15 live qualification. The candidate's exact binary/image
hashes must be frozen before deployment.
