import { tracing } from "cloudflare:workers"

type Attributes = Record<string, string | number | boolean | undefined>

/**
 * Run work inside a named span. Tracing is opt-in through
 * `observability.traces` in wrangler.jsonc; when it is off the callback still
 * runs and nothing is recorded, so call sites stay unconditional.
 */
export function withSpan<T>(name: string, fn: (span: Span) => T, attributes?: Attributes): T {
  return tracing.enterSpan(name, (span) => {
    if (attributes) span.setAttributes(attributes)
    return fn(span)
  })
}

/**
 * Trace id of the current invocation, for correlating an API response with the
 * trace in the dashboard or an OTLP destination. Undefined when tracing is off.
 */
export function traceId(): string | undefined {
  const id = tracing.getActiveSpan()?.spanContext().traceId
  return id && !/^0+$/.test(id) ? id : undefined
}

/** Add attributes to the currently active span, if tracing is on. */
export function annotate(attributes: Attributes): void {
  tracing.getActiveSpan()?.setAttributes(attributes)
}
