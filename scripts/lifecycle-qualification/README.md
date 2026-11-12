# Isolated lifecycle idle qualification preparation

This Worker is a staging-only fixture for measuring idle container close and
same-session reopen for the implemented checkpointed idle policy. Run it only
after the current branch passes its integration gates and the isolated resources
are ready. It has no production bindings.

The fixed DO key is `lifecycle-idle-qualification`. The Worker exposes only:

- `POST /prepare` with an empty body: confirms a fresh isolated DO and globally
  empty R2 bucket, starts the retained evented image through the read-only
  `/onboarding/models` path, creates exactly one titled empty OpenCode session,
  and stores its session ID in `ConversationStore` at idle phase.
- `GET /api/conversations/lifecycle-idle-qualification/context` and
  `GET /api/conversations/lifecycle-idle-qualification/debug`: authenticated
  forwarding to the fixed core context/debug routes for `bench/measure.ts`.
- `POST /cleanup` with an empty body: delegates core deletion, then proves the
  bound R2 bucket is empty.

There is no prompt, provider inference, arbitrary command execution, arbitrary
conversation routing, or generic proxy. Session creation uses the fixed
`/workspace` location and title via the container's authenticated control port.
The control token is read from DO storage and is never returned or logged.
Responses contain only fixed status text and safe stage/session/runtime/image
identity. Upstream response bodies and context messages are not logged.

## Isolated resources

Copy `wrangler.template.jsonc` to an untracked private config and replace the
Worker name, staging account ID, and unique empty R2 bucket name. If the config
is moved, adjust its `main` and `$schema` paths. Use the retained evented image
digest already pinned in the template. The config creates its own SQLite DO
namespaces for Conversation and Settings and binds only the new R2 bucket.

Use a fresh staging API token and fresh 64-character `VAULT_MASTER_KEY` as
Worker secrets. Never copy production secrets, namespace IDs, or bucket names.
Use a private JSON secrets file with `wrangler deploy --secrets-file`; the
installed CLI accepts JSON without dotenv interpolation. Run the dry run against
the filled private config first. Keep the config and any local secret material out of version
control. The first prepare attempt fails closed unless the entire bucket is
empty; cleanup proves it is empty again after core deletion.

## Measurement

After the current branch passes its checks, prepare the fixed DO with an authenticated empty-body `POST /prepare`. Then run
`bench/measure.ts` against the staging Worker with:

```sh
BENCH_IDLE=1 \
HARNESS_URL=https://<unique-staging-worker>.<account>.workers.dev \
API_TOKEN=<fresh-staging-token> \
bun run bench/measure.ts lifecycle-idle-qualification
```

The benchmark requires the existing session, checks close using
`containerRunning === false`, and confirms the same session after context
reopens the runtime. Raw samples include observed idle duration, which also
includes passive polling and checkpoint/stop work. It does not send a turn. Report measurements only after an
actual successful run, with its platform and evidence limits. After recording
the evidence, call authenticated `POST /cleanup` and remove only the exact
staging Worker, its container application, and its bucket.
