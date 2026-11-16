# Decision model providers — 2026-11-16

Primary vendor documentation, live model catalogues and package source were checked on
2026-11-16. No authenticated inference call was made: request and response shapes below come
from published reference pages and OpenAPI/JSON schemas, not from observed traffic. Prices and
model lists are as published on that date. Claims that could not be tied to a primary source are
marked **unverified**. Nothing here was deployed, and no harness code was changed.

## Scope and method

The question: can a per-turn background filter ("is this conversation turn a memory candidate?")
be served by each of OpenAI, OpenRouter, Cloudflare, OpenCode and TypeSafe Jev — and what would a
thin, provider-neutral adapter have to map?

Only primary sources counted: vendor documentation pages, vendor OpenAPI/JSON schema files, vendor
model catalogues (`GET /v1/models`), the npm registry, and the pinned package source in this repo.
Aggregator write-ups, blog explainers and third-party comparisons were read but are not cited as
evidence. Where a vendor documents a feature only through an SDK package, the package source is
cited and the version named.

One correction to the premise up front: the five offerings are not five independent classifier
products. Only two organisations train the models — OpenAI (`gpt-6-luna` Decisions) and TypeSafe
(Jev) — and Cloudflare hosts its own Clef/Clairic models alongside them. OpenRouter and OpenCode
Console are gateways. What they share is **two wire formats**, OpenAI's Decisions API and TypeSafe's
System One API, which is what makes a single adapter realistic.

### What the "decision model" primitive actually is

| Vendor | Ships the primitive itself? | Wire format it speaks |
|---|---|---|
| OpenAI | Yes — purpose-built, GA | OpenAI Decisions (`/v1/decisions`) |
| TypeSafe | Yes — trains Jev | System One (`/v1/systemone`) |
| Cloudflare | Hosts its own models (Clef, Clairic) | System One-shaped, served through the Workers AI Run API |
| OpenCode Console | No — gateway | System One (Jev, GPT-6 Luna Decision, Gemini Decision 1) |
| OpenRouter | No — aggregator | Its own `/api/alpha/decisions` envelope that normalises System One models |

Both formats are typed-question APIs, not chat endpoints with a JSON schema. You send a `state`
(the evidence) and named `questions`; you get back labelled answers with probabilities. No prose,
no rationale, no streaming.

The repo already contains a provider-neutral implementation of this primitive:
[`DecisionModel`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/ai/DecisionModel.ts)
and [`Decision`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/ai/Decision.ts)
in Effect 4.x (`decide`, `decideSettled`, `Classify`/`Rate`/`Probability`), and
[`@opencode/ai`](https://www.npmjs.com/package/@opencode/ai) 2.3.0 ships a `decision()` route per
provider plus the System One and OpenAI Decisions protocols. So the work is mostly wiring and
semantics, not protocol invention.

## Comparison

| Provider | Capability type | Endpoint and shape | Auth | Pricing | Structured output | Batching | Retention |
|---|---|---|---|---|---|---|---|
| OpenAI | Purpose-built decision primitive, GA | `POST https://api.openai.com/v1/decisions`; `model`, `input`, `questions[]` | `Authorization: Bearer $OPENAI_API_KEY` | $0.10 / M uncached input; output not charged; cache read $0.01 / M, cache write $0.125 / M | Typed questions only — no JSON schema, no prose | 1–400 questions per request; `/v1/decisions` is **not** a Batch API endpoint | 30-day abuse logs by default; ZDR and HIPAA for eligible customers; US/EU regional processing |
| OpenRouter | Aggregator of decision models, alpha wire format | `POST https://openrouter.ai/api/alpha/decisions`; `model`, `state`, `questions{}` | `Authorization: Bearer $OPENROUTER_API_KEY` | Pass-through model price, no inference markup; 5.5% fee on credit purchase | Typed questions only | Many questions per request; Batch API supports chat/responses/messages/embeddings only | Prompts stored only on opt-in (plus CSAM screening); per-provider policies exposed; EU/US in-region routing on Business/Enterprise |
| Cloudflare | Purpose-built decision models on Workers AI | `POST /client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef`; `model`, `state`, `questions{}` | `Authorization: Bearer` Cloudflare API token, or the `AI` binding | $0.038 / M input (clef-flash), $0.15 (clef-omni), $0.24 (clef), $0.10 (clairic); output not charged | Typed questions only | 1–64 questions per request; no batch endpoint | Zero data retention stated on every Clef/Clairic model page |
| OpenCode (Console) | Gateway (AI gateway) reselling decision models | `POST https://opencode.ai/inference/systemone/v1/systemone`; System One body | `Authorization: Bearer oc_sk_…` Console key | Jev 1.13 $0.042 / M input; GPT-6 Luna Decision $0.10 / M (≤272K); Gemini Decision 1 $0.10 / M; output free | Typed questions only | Questions per request; no published cap | Console: providers zero-retention and not trained on, apart from named free chat models |
| TypeSafe Jev | The reference decision model | `POST https://api.typesafe.ai/v1/systemone`; `model`, `state`, `questions{}` | `Authorization: Bearer $TYPESAFE_API_KEY` | $0.042 / M input ($42 / Btok); output free | Typed questions only | No count limit — questions per request, bounded by 64k request / 32k question context | Not trained on customer requests or responses; ZDR for enterprise customers |

## OpenAI

**Product and docs.** The Decisions API, documented at
[Decisions](https://developers.openai.com/api/docs/guides/decisions) with the endpoint reference at
[Create a decision](https://developers.openai.com/api/reference/resources/decisions/methods/create).
The guide states it is **generally available** and evaluates "text, images, and JSON" and returns
typed answers "about 10x faster than the Responses API".

**Distinct primitive or prompted small model?** Distinct. `POST /v1/decisions` takes `model`,
`input` and `questions`, and the answers come back as typed values and probabilities rather than
generated text; `input` may be a message list, but the response is never prose. Only `gpt-6-luna`
is supported today. (The same model is also available as a chat model; the guide explicitly
contrasts Decisions with
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) on the
Responses API.)

**Request shape.**

| Field | Content |
|---|---|
| `model` | `gpt-6-luna` (only supported value) |
| `input` | String, or ordered array of messages, function/custom tool calls and outputs; `input_json` content part for structured evidence; `input_text`; `input_image` (data URL or public `https://` URL) |
| `questions` | 1–400 entries; each `predicate`, `choice` or `score`, with `name`, `instructions`, and `choices[]` or `levels[]` where applicable |

Per-part limits from the reference: content strings up to 10,485,760 characters, up to 131,072 input
items, up to 16,384 content parts, JSON input limited to 32 container levels, 10,000 values and
256 KiB. Questions can carry their own images.

**Response shape.** `model`, `answers[]`, `usage`. Each answer is tagged by type:
`predicate` → `probability`; `choice` → `choice`, `probabilities[{value,probability}]`,
`confidence`; `score` → `score` (probability-weighted level index, may fall between levels),
`probabilities[{value,label,probability}]`, `confidence`; `refusal` → `name`, optional `message`.

**Streaming.** Absent. The word "stream" does not appear in the Decisions create reference, and no
`stream` parameter exists.

**JSON-schema support.** None on this endpoint, by design. Schema-shaped extraction belongs to
Structured Outputs on the Responses API.

**Batching.** 1–400 questions per request, evaluated against one shared `input`. The
[Batch API](https://developers.openai.com/api/docs/guides/batch) accepts only
`/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/completions`, `/v1/moderations`
and the image endpoints — `/v1/decisions` is not among them, so there is no 50% batch discount for
decisions.

**Models, limits, pricing.** `gpt-6-luna` is documented at
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) as 1,050,000 context,
922,000 max input, 128,000 max output, text+image input, knowledge cutoff 2026-05-18. The Decisions
guide prices Decisions at **$0.10 per 1M uncached input tokens, output not charged**, cache reads at
the standard `gpt-6-luna` rate and cache writes charged. The model page lists $0.10 input / $0.01
cached input / $0.125 cache write / $0.50 output and a 2x input multiplier above 272K tokens; the
Decisions guide says long-context multipliers and regional premiums apply to `/v1/decisions` too.
A Decisions-specific context limit is **unverified** — the guide documents the 400-question cap but
not a token ceiling for the endpoint.

Prompt caching is supported on `input` (implicit breakpoint at the end of shared input, minimum
1,024 reusable tokens, `prompt_cache_key`, explicit breakpoints; question content is outside the
prefix). `GET /v1/organization/usage/decisions` reports token usage and request counts.

**Latency.** One published comparative claim: "about 10x faster than the Responses API". No
per-request millisecond figure.

**Rate limits.** No Decisions-specific limits are published; the general
[rate limits](https://developers.openai.com/api/docs/guides/rate-limits) scheme (RPM/TPM by usage
tier) applies. Exact tier numbers for `gpt-6-luna` decisions are **unverified**.

**Data handling.** The guide states Decisions "supports Zero Data Retention (ZDR) and HIPAA use for
eligible customers", with data residency in all supported API regions and regional processing in the
United States and Europe (EEA + Switzerland). The default posture, from
[Your data](https://developers.openai.com/api/docs/guides/your-data): API data is not used for
training unless opted in; abuse-monitoring logs are retained up to 30 days by default, and ZDR or
Modified Abuse Monitoring removes customer content from those logs for approved customers.

**Also available, but not this primitive.** `omni-moderation-latest` is a free fixed-taxonomy
classifier ([Moderation](https://developers.openai.com/api/docs/guides/moderation)); it answers
safety categories, not arbitrary questions, so it cannot serve a general memory-candidate filter.

## OpenRouter

**Product and docs.** The Decisions API at
[Decisions API](https://openrouter.ai/docs/guides/features/decisions), reference at
[Submit a Decisions request](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request),
plus a per-provider compatibility guide at
[Multimodal Decisions](https://openrouter.ai/docs/guides/community/multimodal-decisions).
The endpoint is explicitly **alpha** and may change.

**Distinct primitive or prompted model?** Distinct wire format and a curated set of decision
models, not one model. `POST /api/alpha/decisions` with `model`, `state`, `questions`, optional
`assets`, `provider`, `session_id`, `user`. The guide names TypeSafe Jev, Cloudflare Clef,
Inception Mercury Decide and Liquid D1, and the live catalogue returns **41 models** for
`?output_modalities=decisions`
([models API](https://openrouter.ai/api/v1/models?output_modalities=decisions)), including
`typesafe/jev-1.14`, `cloudflare/clef-flash`, `cloudflare/clef-omni`, `cloudflare/clairic`,
`google/gemini-decision-1`, `liquid/d1.1`, `scaledown/classify-1`, `microsoft/microsoft-decision-1`,
`perplexity/pplx-decider-*` and Baseten's decision models.

**Request shape.** `state` as a string or an array of text strings and `image_url` /
`input_audio` / `video_url` parts; `questions` as an object keyed by question id; optional `assets`
map for reusable images; optional `provider` routing preferences (`order`, `only`, `ignore`,
`options`). Accepted question types, media parts and asset references depend on the model: an
unsupported combination fails with `400` before anything is sent upstream.

**Response shape.** `id`, `model`, `provider`, `answers{}` (keyed by question id, each tagged
`noul` | `choice` | `score` | `box` | `refusal`), `usage` with `input_tokens`, `output_tokens`,
`cost` and `input_tokens_details.cached_tokens`. Choice and score answers carry `probabilities` and
`confidence`; `noul` answers are a single probability.

**Streaming.** Not supported — no stream option is documented and the response is a single JSON
document.

**JSON-schema support.** None on this endpoint; the docs point at Chat Completions with
`json_schema` for arbitrary JSON instead.

**Batching.** Multiple questions per request; no published cap (model-dependent, **unverified**).
The [Batch API](https://openrouter.ai/docs/batch-quickstart) accepts `endpoint` =
`/v1/chat/completions`, `/v1/responses`, `/v1/messages` or `/v1/embeddings` only, so decisions get
no batch discount.

**How per-upstream differences surface.** Three ways, all documented: the response `provider` field
names the serving provider; the request `provider` object restricts routing; and the multimodal
guide tabulates per-model differences (image caps — 4 for Clef family, 16 for Mercury Decide and
Baseten, 128 for GPT-6 Luna Decisions; Jev accepts only PNG/JPEG and reads images at any depth,
every other model reads images only as top-level `state` items; Jev 1.14 alone supports `box`).
This is the important operational property: the same question can be answered by different upstream
implementations with different media support and different confidence numbers, and the envelope
stays constant.

**Routing/classification as a product.** Two adjacent products exist, neither a general decision
filter: [Jev Router](https://openrouter.ai/docs/guides/routing/routers/jev-router) uses Jev to pick
a model and reasoning effort for a chat request (`typesafe/jev-router`, `cost_tier`), and
[Classifications](https://openrouter.ai/docs/client-sdks/typescript/sdks/classifications/README.md)
is a usage market-share statistics endpoint, not a classifier for your content.

**Pricing and fees.** Pass-through model pricing with **no inference markup**; a **5.5% ($0.80
minimum) fee on credit purchases** and 5% on crypto
([FAQ](https://openrouter.ai/docs/faq)). Decision models are input-priced with free output; the
catalogue reports e.g. `typesafe/jev-1.14` at $0.042/M input, `cloudflare/clairic` at $0.10/M,
`cloudflare/clef-omni` at $0.15/M. The response `usage.cost` reports the exact credits charged.

**Rate limits.** [Limits](https://openrouter.ai/docs/api_reference/limits) documents free-model caps
(20 RPM; 50 or 1,000 RPD by lifetime credits), key-management caps and per-IP burst limits. No
Decisions-specific limit is published; upstream 429s are retried against fallback providers when
routing allows, and `error.metadata.provider_code` carries the upstream code.

**Latency.** No published figure.

**Data handling.** Prompts and responses are not stored unless you opt in to private logging or to
product-improvement use, with CSAM screening in flight as the documented exception
([Data Collection](https://openrouter.ai/docs/guides/privacy/data-collection)). Provider logging and
retention tiers, including ZDR, are per provider
([Provider Logging](https://openrouter.ai/docs/guides/privacy/provider-logging)); account-level
settings can exclude training providers and require ZDR. `https://eu.openrouter.ai` /
`https://us.openrouter.ai` give in-region routing on Business and Enterprise plans.

## Cloudflare

**Product and docs.** Workers AI hosts four decision models, each with its own model page and raw
input/output JSON schemas:

| Model | Size / shape | Context | Price (input) | Docs |
|---|---|---|---|---|
| `@cf/cloudflare/clef` | 27B multimodal | 65,536 | $0.24 / M | [clef](https://developers.cloudflare.com/workers-ai/models/clef/) |
| `@cf/cloudflare/clef-flash` | 9B multimodal | 24,576 | $0.038 / M | [clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) |
| `@cf/cloudflare/clef-omni` | 30B MoE (3B active), text/JSON/image/audio/video | 64,000 | $0.15 / M | [clef-omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/) |
| `@cf/cloudflare/clairic` | "System One-style", typed fields | 65,536 | $0.10 / M | [clairic](https://developers.cloudflare.com/workers-ai/models/clairic/) |

**Distinct primitive or prompted model?** Distinct. Clef is documented as "a 27B multimodal
decision model that turns a state and a schema of typed questions into decisions… returns a
probability for every allowed option of every question". Output is input-priced only; "Clef models
do not charge for output tokens".

**Request/response shape.** `POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef`
(or `env.AI.run("@cf/cloudflare/clef", …)`), body:

- `model` — required, and on the clef and clef-flash pages the schema pattern is
  `^\s*(clef|clef-flash)\s*$`, i.e. the **short name**, not the `@cf/...` id used in the path;
- `state` — required; string or structured object/array; long text is truncated to fit;
- `questions` — required, **1 to 64** entries, ids up to 100 chars of `[A-Za-z0-9_.-]`;
- `images` — optional, max 4, embedded PNG/JPEG/WebP, 4 MiB and 16 MP each, 8 MiB decoded total,
  13 MiB whole body, no remote URLs.

Response per the output schema: `model`, `answers{}` keyed by question id, `usage{input_tokens,
output_tokens}`. Answer types are `noul` (`noul`), `choice` (`choice`, `probabilities`,
`confidence`), `score` (`score`, `legend`, `probabilities`, `confidence`). There is **no refusal
type** in the schema, so a declined or missing answer has to be treated as absent.

**Streaming.** Not part of the schema or docs.

**JSON-schema support.** None; the schema is fixed to the three question types.

**Batching.** 1–64 questions per request, all evaluated against the same state. No batch endpoint is
documented for these models.

**OpenAI-compatible endpoint.** The
[OpenAI compatible API endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
cover Chat Completions and embeddings (Responses only for GPT-OSS). Decision models are **not**
reachable through `/ai/v1/chat/completions`; they use the Run API. The provider SDK reflects this:
`@opencode/ai` builds its Cloudflare decision route from the Run base URL, not the OpenAI-compatible
base.

**Pricing and rate limits.** [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing):
$0.011 per 1,000 Neurons, 10,000 Neurons/day free, Workers Paid for more; Clef models are not on the
"requires a paid billing method" list. [Limits](https://developers.cloudflare.com/workers-ai/platform/limits):
Text Generation defaults to 300 requests/minute; models that require Workers Paid are limited to 20
RPM (50 RPM with prepaid AI Gateway credits). Media is billed as input tokens — images at one token
per 32×32 patch (max 1,024 tokens each); audio ≈780 tokens/min and video up to ≈15,400 tokens/min
apply to clef-omni.

**Latency.** Described as "fast" for clef-flash; no numeric claim published.

**Data handling.** Every one of the four model pages lists **Zero data retention: Yes**. The docs do
not state a training-on-customer-data policy for Clef on those pages — **unverified**.

**AI Gateway as a decision filter.** It is not one. [Guardrails](https://developers.cloudflare.com/ai-gateway/features/guardrails/)
inspects prompts and responses for harmful content categories and flags or blocks; the
[supported model types](https://developers.cloudflare.com/ai-gateway/features/guardrails/supported-model-types/)
page describes text-generation, embedding and unknown-model handling and notes guardrails do not
support `stream: true`. [Routing](https://developers.cloudflare.com/ai-gateway/features/routing/)
and [Auto Router](https://developers.cloudflare.com/ai-gateway/features/routing/auto-router/) select
a model per request — Auto Router does run "a classification step" internally, but it exposes only
the chosen model and reason headers (`cf-aig-routed-model`, `cf-aig-routing-reason`,
`cf-aig-routing-decision-id`), not labels, probabilities or scores. Neither product can answer an
application-defined accept/reject question.

## OpenCode (Console)

**What the provider is.** `opencode/<model>` is **OpenCode Console**, described at
[Console](https://opencode.ai/docs/console/) as an optional service and, in the
[Models](https://opencode.ai/docs/console/models/) page, plainly as "an AI gateway" that provides
tested models, workspaces, budgets, provider passthrough and harness support. The current docs do not
use a "Zen" brand for this service: `https://opencode.ai/inference` is the pay-as-you-go base URL and
`https://opencode.ai/inference/go` the subscription base URL
([Harnesses](https://opencode.ai/docs/console/harnesses/)).

The harness in this repo targets it as `opencode/deepseek-v4.1-flash`
([`src/settings.ts`](../../src/settings.ts)), and the container sees it through a local
OpenAI-compatible shim, `aboiteau-proxy` with package `@opencode/ai/providers/openai-compatible`
([`src/provider-proxy-config.ts`](../../src/provider-proxy-config.ts)).

**Does it offer a decision model or only chat?** Both. Chat is the `opencode/<model>` catalogue
(87 chat models returned by `GET https://opencode.ai/inference/v1/models` on the check date), each
served through OpenAI Responses, Chat Completions, Anthropic Messages or Gemini paths. Decision
models are a separate, documented set on the **System One** endpoint:

| Model id | Endpoint | Price (input) |
|---|---|---|
| `jev-1.13` | `https://opencode.ai/inference/systemone/v1/systemone` | $0.042 / M |
| `jev-1.13-free` | same | Free (limited time) |
| `gpt-6-luna-decision` | same | $0.10 / M ≤272K, $0.20 / M above; $0.01/$0.02 cache read |
| `gemini-decision-1` | same | $0.10 / M |

Output is free for all four. The page's [Jev](https://opencode.ai/docs/console/models/#jev) section
gives working curl for `noul`, `choice` and `score`, and states that
`gpt-6-luna-decision` / `gemini-decision-1` take the same System One request, with media passed in
`state` as chat-style parts (`image_url`, `input_audio`, `video_url`, `file`) — GPT-6 Luna Decision
accepts text and images, Gemini Decision 1 also audio, video and PDFs.

**Notable catalogue gap.** The live `GET /inference/v1/models` returned **87 entries, all
`type: "chat"`** — no decision models, no `api.systemone` block. The decision models appear in the
documentation table and on the System One endpoint, not in that JSON. Anything that discovers
decision models from `/inference/v1/models` will miss them (verified 2026-11-16).

**Request/response shape.** Identical to TypeSafe System One: `{model, state, questions}` in;
`{model, answers{…}, usage}` out; `Authorization: Bearer oc_sk_…`. Whether the gateway forwards
TypeSafe's error codes verbatim is **unverified** — the Console pages document neither the error body
nor the decision-model limits. Context/output limits for the three decision models are **not
published** on the Console pages.

**Streaming / JSON schema / batching.** No streaming on the System One endpoint (not documented), no
JSON-schema mode, questions batched per request as in System One. No published per-request question
cap for Console.

**Latency and rate limits.** Not published — **unverified**. Budgets and per-member spend caps are
documented ([Billing](https://opencode.ai/docs/console/billing), [Budgets](https://opencode.ai/docs/console/budgets)).

**Data handling.** The [Privacy](https://opencode.ai/docs/console/models/#privacy) section: "All our
models are hosted in the US and EU. Our providers follow a zero-retention policy and do not use your
data for model training", with a named list of exceptions — all of them free chat models. Jev 1.13
Free is described only as "available for a limited time", and is not in the exception list; that it
inherits zero retention is an inference from the general statement, so **treat as unverified until
confirmed in writing**.

**Adapter-relevant repo fact.** The container's provider egress path cannot reach a decision
endpoint. [`src/provider-egress.ts`](../../src/provider-egress.ts) fixes the upstream to
`https://api.openai.com/v1/chat/completions`, forwards only chat-completions bodies, rejects any
`model` outside the grant scope, and collapses every non-2xx except 429 into `502 provider
unavailable`. A decision call would need either a second allowlisted destination plus a new scope
kind, or to be made outside the container (Worker/DO).

## TypeSafe Jev

**Product and docs.** [Introduction](https://docs.typesafe.ai/introduction), model facts at
[Models](https://docs.typesafe.ai/models), reference at
[System One](https://docs.typesafe.ai/api/system-one) with the machine-readable
[OpenAPI 3.1 spec](https://api.typesafe.ai/openapi.json) (`info.version` 0.2.0). Jev is "the first
System One model"; System One is described in
[System One](https://docs.typesafe.ai/concepts/system-one) as models "built to make fast, structured
decisions that software can use directly", trained for calibrated probabilities rather than text.

**Distinct primitive or prompted model?** Distinct, and it is the reference implementation of the
shape the other vendors copy. One endpoint, `POST /v1/systemone`; the `model` field selects the
version.

**Request shape.**

| Field | Content |
|---|---|
| `model` | `jev-latest` (alias → `jev-1.14.0`), `jev-preview`, `jev-1.14.0`, `jev-1.13.0`, or any name from `GET /v1/models` |
| `state` | Required; string, JSON object, or array of text values, with PNG/JPEG images anywhere |
| `questions` | Object keyed by question id; each `{type, instructions, criteria}` with `type` ∈ `noul`, `choice`, `score`, `box` |
| `assets` | Optional image map (`{type:"image", format, data_base64}`) referenced from the state |

Headers: `Authorization: Bearer <API_KEY>`, optional `TypeSafe-Danger-Zone-Images: true` (assets and
box), optional `TypeSafe-Danger-Zone-Long-Context: true`. Multipart is accepted for images. Request
rules from [Errors](https://docs.typesafe.ai/api/errors): body ≤ 32 MiB, UTF-8 without BOM, ≤ 64
levels of nesting, finite numbers only; gzip or zstd body compression allowed.

**Response shape.** `model` (the versioned id that answered), `answers{}` keyed by question id,
`usage{input_tokens, output_tokens}`. Answers: `noul` → `noul` (0–1); `choice` → `choice`,
`probabilities{}`, `confidence`; `score` → `score` (probability-weighted level, may fall between
levels), `legend`, `probabilities{}`, `confidence`; `box` → `box{top,bottom,left,right}`,
`confidence` (1.14 only).

**Confidence semantics.** Documented in detail at
[Confidence](https://docs.typesafe.ai/confidence): `confidence` is a deterministic function of the
returned distribution (1.0 when all mass is on one option, 0 when spread evenly; for a 3-option
Choice, `(3 × p_max − 1) / 2`), separate from probability. The docs are explicit that calibration is
a group-level property: "Calibration is measured across groups of predictions; it does not guarantee
that an individual answer is correct." `noul` answers carry no `confidence`; the probability is the
signal.

**Streaming.** None. JSON response only.

**JSON-schema support.** None, and not needed: answers are typed by the question definition.

**Batching and limits.** "There is no separate limit on the number of questions in a request" — the
only bounds are per-request context (state + all questions) and per-question context (state + one
question). Defaults 64k / 32k tokens; with the long-context header both become 262k, at the same
per-token price but "slower and less accurate". No standalone batch endpoint; batching means packing
questions into one request. The [parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions)
measures 13 questions in one call as 12.2x cheaper and 11.8x faster than separate calls.

**Pricing.** [Models](https://docs.typesafe.ai/models): $42 per Btok / **$0.042 per Mtok input**,
output free, for both 1.14 and 1.13. Long context costs the same per token. Rate limits are per
organization, measured in tokens/second and requests/second, visible in the developer console, with
custom/enterprise increases; exact values are account-specific and therefore **unverified** here.

**Latency.** "Most calls complete in about 100 ms" (introduction) and "frontier intelligence in about
150ms" for real-time app use. These are marketing claims on the same docs site, not a published
percentile.

**Data handling.** Legal index at [Legal](https://docs.typesafe.ai/legal): DPA, MCA, privacy policy,
plus "zero data retention (ZDR) for enterprise customers" on request. Models page: "Jev is not
trained on customer requests or responses" and "is not fine-tuned or LoRA-adapted with customer
data". Region options are not documented on the public pages — **unverified**.

**Directly relevant cookbook.** [Simple memory system](https://docs.typesafe.ai/cookbooks/basic_memory)
implements exactly this harness's proposed filter: after a call, one `Noul` question ("does the
request state an important fact about the customer that should be remembered?") and a threshold
(`P(yes) ≥ 0.5`) decides whether to persist the turn as a memory. It is a working reference design
for the accept/reject decision, and it quantifies why the threshold matters: in its routing example,
computing the route without memory gets 3 of 6 later tickets right, and with the remembered turn all
6 do — so the filter's precision feeds directly into downstream behaviour.

## Adapter implications

The neutral surface this repo already has (`Decision.Classify`, `Decision.Rate`,
`Decision.Probability`, plus `decide` / `decideSettled`) maps almost one-to-one onto both wire
formats. The mapping table:

| Neutral decision | OpenAI Decisions | System One (TypeSafe / Cloudflare / OpenCode / OpenRouter) |
|---|---|---|
| `Classify` (labels + descriptions) | `type:"choice"`, `choices[{value,description}]` | `type:"choice"`, `criteria{label: description}` |
| `Rate` (ordered levels) | `type:"score"`, `levels[{label,description}]` | `type:"score"`, `criteria[level, …]` |
| `Probability` (statement) | `type:"predicate"`, `instructions` | `type:"noul"`, `instructions`, optional `criteria{true,false}` |
| locate (out of scope) | not supported | `type:"box"` (Jev 1.14, OpenRouter `typesafe/jev-1.14`, Clef omits box) |

Per provider, what a thin adapter must actually get right:

| Provider | Request mapping | Response mapping | Confidence semantics | Failure modes to handle |
|---|---|---|---|---|
| OpenAI | Named `questions[]` array (not a map); input as messages or `input_json`; 400-question cap | `answers[]` array → key by `name`; `probabilities` is an array of `{value,probability}`, not a map; `score` is already probability-weighted | Provider computes `confidence`; docs tell you to set thresholds from labelled examples | Per-question `refusal`; absent answer; 400 for invalid/too many questions; images only, no audio/video/files; no stream |
| OpenRouter | `questions{}` map; `state` string or part array; `assets` optional; `provider` pinning | `answers{}` keyed; `usage.cost` present; `provider` names upstream | Same shape, but numbers come from whichever upstream served — pin `provider` if thresholds matter | `type:"refusal"` per question; 400 for unsupported media/question/model combination; upstream 429 with `provider_code`; alpha schema change |
| Cloudflare | `model` must be the **short** name (`clef`, `clef-flash`), path carries `@cf/cloudflare/clef`; `questions{}`; 64-question cap; images in top-level `images[]`, no URLs | `answers{}` keyed; choice/score include `probabilities` map and `confidence`; score includes `legend` | Same formula family; verify per model before sharing thresholds across Clef variants | **No refusal type** — treat missing answer as absent; 400 on >64 questions, >4 images, oversized body; Clef-flash 24k context is the tightest ceiling |
| OpenCode | System One body unchanged; `Authorization: Bearer oc_sk_…`; model ids `jev-1.13`, `jev-1.13-free`, `gpt-6-luna-decision`, `gemini-decision-1` | System One response unchanged | Jev models: Jev semantics. GPT/Gemini-backed: same answer shape, model-defined confidence — **unverified** that it matches Jev's calibration | 401/403 for free chat models outside OpenCode; undocumented decision-model context limits; no streaming; not in `/inference/v1/models` |
| TypeSafe | Reference shape; `questions{}`; long-context and image headers opt-in; 32 MiB body | Reference shape; `answers{}`; `model` echoes the versioned id | Confidence derived from distribution and documented per question type; `noul` has none | 400/413/415/422 validation; 429 and 529 overload (retry with backoff); no refusal type — a declined or missing answer is simply absent; aliases move |

### Which of these could NOT serve a per-turn decision filter

All five have the primitive as of 2026-11-16, so the honest answer is "all five can, with different
amounts of wiring". What does rule things out is narrower and concrete:

1. **The model configured today cannot.** `opencode/deepseek-v4.1-flash` is a chat model in the
   Console catalogue; using it as a filter means prompt-and-parse with a small general model, not a
   typed decision call. It returns prose and tool calls, not calibrated probabilities, and the
   harness would own the parsing and the confidence story.
2. **The container egress path cannot reach any of them.** `proxyProviderRequest` posts only to
   `https://api.openai.com/v1/chat/completions` with a chat-completions body, and converts every
   non-2xx except 429 to 502. As written, no decision endpoint is reachable from inside the
   container; the call has to move to the Worker/DO or the proxy needs a second destination and a
   new scope kind. This is the single largest implementation cost in the list.
3. **No provider offers a batch discount for decisions**, so a filter cannot be made cheap by
   deferring. OpenAI Batch and OpenRouter Batch both exclude decision endpoints; Cloudflare,
   TypeSafe and Console document no batch API for them. Cost therefore scales per turn — arithmetic
   from the published rates: a 2,000-token turn costs about $0.00008 at clef-flash's $0.038/M,
   $0.00008 at Jev's $0.042/M, $0.0002 at $0.10/M and $0.00048 at clef's $0.24/M. At one decision
   per turn that is noise next to any chat-model turn, so **cost is not the disqualifier; added
   latency and a second failure mode are.**
4. **Nothing streams.** All five are request/response with a typed body, so the filter must be an
   awaited call with a timeout and a documented fallback (skip the filter, or default to "don't
   remember") — it cannot be bolted onto the SSE reader as a side channel.
5. **Cloudflare's caps bind first.** A 64-question ceiling, 24,576-token context on clef-flash and a
   13 MiB body limit are fine for one accept/reject question but rule out "ask everything about this
   turn" bundles that Jev or OpenAI would accept.

## Open questions / not verified

- **OpenAI Decisions context limit.** The guide documents 1–400 questions and mentions long-context
  multipliers, but no token ceiling for `/v1/decisions`. Whether the 1,050,000-token `gpt-6-luna`
  window fully applies is unverified.
- **OpenAI Decisions rate limits.** No per-endpoint RPM/TPM figures published; tier behaviour for
  `gpt-6-luna` decisions is unverified.
- **OpenCode decision-model limits.** Context/output ceilings, per-request question caps and rate
  limits for `jev-1.13`, `gpt-6-luna-decision` and `gemini-decision-1` are not on the Console pages.
- **OpenCode confidence equivalence.** Whether `gpt-6-luna-decision` and `gemini-decision-1` return
  OpenAI/Google-calibrated confidence or a gateway-normalised number is unverified; a shared
  threshold across `jev-1.13` and the vendor-backed models is not safe without measurement.
- **Jev 1.13 Free retention.** Not named in the privacy exceptions, and not named as zero-retention
  either. Confirm before sending conversation content to the free id.
- **OpenRouter decisions limits.** No published per-request question cap or decisions-specific rate
  limit; the alpha envelope may change without notice.
- **Cloudflare training policy.** Model pages state ZDR; they do not state whether Clef/Clairic
  prompts are used for training. Unverified.
- **Cloudflare latency.** Clef-flash is described as "fast"; no milliseconds, no percentiles, and no
  published concurrency guidance for 300 RPM text-generation limits.
- **TypeSafe rate limits and region.** Per-org TPS/RPS values and any region/residency options are
  behind the console and sales; enterprise ZDR requires a support request.
- **TypeSafe batch.** No batch endpoint is documented; confirm there is no private/enterprise batch
  path before assuming per-request pricing at volume.
- **Observed vs documented shapes.** No authenticated request was made to any provider, so all
  response examples are documentary. A staging smoke against one provider per wire format would
  settle streaming, timeout and refusal behaviour before wiring the filter.
- **Out of scope.** Google's own Decisions API (behind `gemini-decision-1`), Azure OpenAI's Decisions
  availability, Baseten/DigitalOcean decision routes that `@opencode/ai` 2.3.0 also supports, and
  LiteLLM's `/v1/decisions` proxy were seen but not researched.

## Sources

Vendor documentation and catalogues (checked 2026-11-16):

1. https://developers.openai.com/api/docs/guides/decisions
2. https://developers.openai.com/api/reference/resources/decisions/methods/create
3. https://developers.openai.com/api/docs/models/gpt-6-luna
4. https://developers.openai.com/api/docs/guides/your-data
5. https://developers.openai.com/api/docs/guides/batch
6. https://developers.openai.com/api/docs/guides/moderation
7. https://developers.openai.com/api/docs/guides/rate-limits
8. https://openrouter.ai/docs/guides/features/decisions
9. https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request
10. https://openrouter.ai/docs/guides/community/multimodal-decisions
11. https://openrouter.ai/api/v1/models?output_modalities=decisions
12. https://openrouter.ai/docs/faq
13. https://openrouter.ai/docs/api_reference/limits
14. https://openrouter.ai/docs/guides/privacy/data-collection
15. https://openrouter.ai/docs/guides/privacy/provider-logging
16. https://openrouter.ai/docs/guides/routing/routers/jev-router
17. https://openrouter.ai/docs/batch-quickstart
18. https://openrouter.ai/docs/client-sdks/typescript/sdks/classifications/README.md
19. https://developers.cloudflare.com/workers-ai/models/clef/
20. https://developers.cloudflare.com/workers-ai/models/clef-flash/
21. https://developers.cloudflare.com/workers-ai/models/clef-omni/
22. https://developers.cloudflare.com/workers-ai/models/clairic/
23. https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json
24. https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
25. https://developers.cloudflare.com/workers-ai/platform/limits/
26. https://developers.cloudflare.com/workers-ai/platform/pricing/
27. https://developers.cloudflare.com/ai-gateway/features/guardrails/
28. https://developers.cloudflare.com/ai-gateway/features/guardrails/supported-model-types/
29. https://developers.cloudflare.com/ai-gateway/features/routing/
30. https://developers.cloudflare.com/ai-gateway/features/routing/auto-router/
31. https://opencode.ai/docs/console/
32. https://opencode.ai/docs/console/models/
33. https://opencode.ai/docs/console/api/inference/
34. https://opencode.ai/docs/console/harnesses/
35. https://opencode.ai/inference/v1/models
36. https://docs.typesafe.ai/introduction
37. https://docs.typesafe.ai/models
38. https://docs.typesafe.ai/concepts/system-one
39. https://docs.typesafe.ai/api/system-one
40. https://api.typesafe.ai/openapi.json
41. https://docs.typesafe.ai/api/errors
42. https://docs.typesafe.ai/confidence
43. https://docs.typesafe.ai/legal
44. https://docs.typesafe.ai/cookbooks/basic_memory
45. https://docs.typesafe.ai/cookbooks/parallel_questions

Package sources and local repo files:

46. https://www.npmjs.com/package/@opencode/ai — v2.3.0; route source at https://unpkg.com/@opencode/ai@2.3.0/dist/providers/opencode.js, `openai.js`, `openrouter.js`, `cloudflare-workers-ai.js`, `openai-compatible.js`, and `dist/protocols/system-one.js`, `openai-decisions.js`, `cloudflare-run-decisions.js`
47. https://github.com/Effect-TS/effect/blob/main/packages/effect/src/ai/DecisionModel.ts
48. https://github.com/Effect-TS/effect/blob/main/packages/effect/src/ai/Decision.ts
49. [`src/settings.ts`](../../src/settings.ts) — default `opencode/deepseek-v4.1-flash`
50. [`src/provider-proxy-config.ts`](../../src/provider-proxy-config.ts) — `@opencode/ai/providers/openai-compatible`, `aboiteau-proxy`
51. [`src/provider-egress.ts`](../../src/provider-egress.ts) — fixed `api.openai.com/v1/chat/completions`, non-2xx → 502
