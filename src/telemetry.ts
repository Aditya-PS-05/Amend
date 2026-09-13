/**
 * Optional Lemma tracing (https://docs.uselemma.ai) via the official @uselemma/tracing SDK.
 *
 * Off unless LEMMA_API_KEY and LEMMA_PROJECT_ID are set (and AMEND_TRACING is not "off").
 * When off, `traced()` is a zero-cost passthrough and the SDK is never loaded.
 *
 * The Lemma SDK has no ambient context, so we keep one in AsyncLocalStorage:
 * the outermost `traced()` call opens a Lemma trace (one agent run), and nested
 * calls become child spans. A span whose attributes include `gen_ai.system` is
 * recorded as a Lemma "generation" (model, token usage, input/output).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Lemma, SpanHandle, TraceContext } from "@uselemma/tracing";

export type Attributes = Record<string, string | number | boolean | undefined>;

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Handle passed to the traced callback so it can record results. No-ops when tracing is off. */
export interface SpanRecorder {
  setAttributes(attributes: Attributes): void;
  setInput(input: unknown): void;
  setOutput(output: unknown): void;
  setUsage(usage: TokenUsage | undefined): void;
}

interface Scope {
  trace: TraceContext;
  span?: SpanHandle;
}

let lemma: Lemma | undefined;
let captureContent = true;
const storage = new AsyncLocalStorage<Scope>();
const inFlight = new Set<Promise<unknown>>();

const noopRecorder: SpanRecorder = {
  setAttributes() {},
  setInput() {},
  setOutput() {},
  setUsage() {},
};

export function tracingEnabled(): boolean {
  return lemma !== undefined;
}

export async function initTelemetry(): Promise<void> {
  if (lemma) return;
  const apiKey = process.env.LEMMA_API_KEY?.trim();
  const projectId = process.env.LEMMA_PROJECT_ID?.trim();
  if (process.env.AMEND_TRACING === "off" || !apiKey || !projectId) {
    console.log("[telemetry] Lemma tracing off (set LEMMA_API_KEY and LEMMA_PROJECT_ID to enable)");
    return;
  }
  try {
    const { Lemma } = await import("@uselemma/tracing");
    lemma = new Lemma({
      apiKey,
      projectId,
      baseUrl: process.env.LEMMA_BASE_URL?.trim() || undefined,
      release: process.env.LEMMA_RELEASE?.trim() || undefined,
    });
    captureContent = process.env.LEMMA_CAPTURE_CONTENT !== "false";
    console.log(`[telemetry] Lemma tracing on (project ${projectId}${captureContent ? "" : ", content capture off"})`);
  } catch (err) {
    lemma = undefined;
    console.warn(`[telemetry] Lemma tracing off: failed to initialise SDK (${(err as Error).message})`);
  }
}

function clean(attributes: Attributes): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attributes)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Run `fn` inside a span. The outermost call opens a Lemma trace; nested calls are child spans.
 * Exceptions are recorded (status ERROR) and rethrown unchanged. Passthrough when tracing is off.
 */
export async function traced<T>(name: string, attributes: Attributes, fn: (span: SpanRecorder) => Promise<T>): Promise<T> {
  const client = lemma;
  if (!client) return fn(noopRecorder);

  const parent = storage.getStore();
  if (!parent) {
    const threadKey = attributes["amend.thread_key"];
    const run = client.trace(
      {
        name,
        threadId: typeof threadKey === "string" ? threadKey : undefined,
        metadata: clean(attributes),
        // The SDK records the callback's return value as trace output unless one is given.
        ...(captureContent ? {} : { output: null }),
      },
      (trace) => storage.run({ trace }, () => runSpan(trace, undefined, name, attributes, fn)),
    );
    inFlight.add(run);
    try {
      return await run;
    } finally {
      inFlight.delete(run);
    }
  }
  return runSpan(parent.trace, parent.span, name, attributes, fn);
}

async function runSpan<T>(
  trace: TraceContext,
  parentSpan: SpanHandle | undefined,
  name: string,
  attributes: Attributes,
  fn: (span: SpanRecorder) => Promise<T>,
): Promise<T> {
  const attrs = clean(attributes);
  const isGeneration = typeof attrs["gen_ai.system"] === "string";
  const model = typeof attrs["gen_ai.request.model"] === "string" ? (attrs["gen_ai.request.model"] as string) : undefined;
  const owner = parentSpan ?? trace;
  let span: SpanHandle;
  try {
    span = isGeneration
      ? owner.startGeneration({ name, model, llmProvider: String(attrs["gen_ai.system"]), attributes: attrs })
      : owner.startSpan({ name, attributes: attrs });
  } catch {
    // Never let instrumentation break the agent.
    return fn(noopRecorder);
  }

  let input: unknown;
  let output: unknown;
  let usage: TokenUsage | undefined;
  const recorder: SpanRecorder = {
    setAttributes: (a) => Object.assign(attrs, clean(a)),
    setInput: (v) => {
      if (captureContent) input = v;
    },
    setOutput: (v) => {
      if (captureContent) output = v;
    },
    setUsage: (u) => {
      usage = u;
      if (u?.inputTokens !== undefined) attrs["gen_ai.usage.input_tokens"] = u.inputTokens;
      if (u?.outputTokens !== undefined) attrs["gen_ai.usage.output_tokens"] = u.outputTokens;
    },
  };

  try {
    const result = await storage.run({ trace, span }, () => fn(recorder));
    safeEnd(span, { status: "OK", attributes: attrs, input, output, usage });
    if (!parentSpan && captureContent) {
      if (input !== undefined) trace.input(input);
      if (output !== undefined) trace.output(output);
    }
    return result;
  } catch (error) {
    safeEnd(span, { status: "ERROR", error, attributes: attrs, input, usage });
    throw error;
  }
}

function safeEnd(span: SpanHandle, options: Parameters<SpanHandle["end"]>[0]): void {
  try {
    span.end(options);
  } catch {
    /* instrumentation must fail open */
  }
}

/** Map an Anthropic `usage` block onto Lemma token usage. */
export function anthropicUsage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
} | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? undefined,
    outputTokens: usage.output_tokens ?? undefined,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? undefined,
  };
}

/** Wait for in-flight traces to be delivered (the SDK sends each trace when its root span ends). */
export async function shutdownTelemetry(timeoutMs = 5000): Promise<void> {
  if (!lemma || inFlight.size === 0) return;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}
