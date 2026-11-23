import { OpenTelemetry } from "@ai-sdk/otel";
import { context, diag, DiagLogLevel } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { PostHogSpanProcessor } from "@posthog/ai/otel";
import type { PostHog } from "posthog-node";

/**
 * Sends the AI agent's traces to PostHog's LLM analytics: each run, its model
 * calls with their latency, tokens and cost, and its tool calls. Like the
 * rest of HuddleFM's analytics it leaves out what people wrote (privacy
 * mode), unless `recordContent` is set (POSTHOG_LLM_CONTENT): then the
 * prompt, replies, and tool arguments and results go too, for debugging. A
 * run is credited to whoever is in the PostHog client's context when it
 * starts, so the agent runs inside `client.withContext`.
 */
export class LlmTracing {
  private telemetry: OpenTelemetry;

  private constructor(
    private provider: TracerProvider,
    private recordContent: boolean,
  ) {
    this.telemetry = new OpenTelemetry({
      tracer: provider.getTracer("huddlefm"),
    });
  }

  /** The AI SDK `telemetry` setting that traces a run. */
  telemetryOptions() {
    return {
      isEnabled: true,
      recordInputs: this.recordContent,
      recordOutputs: this.recordContent,
      integrations: this.telemetry,
    };
  }

  static create(
    apiKey: string,
    host: string | undefined,
    client: Pick<PostHog, "getContext">,
    onError: (error: unknown) => void = () => {},
    recordContent = false,
  ) {
    // A trace PostHog refused, or a host it couldn't reach, is only told to
    // OpenTelemetry's logger; it's reported like the other analytics.
    const report = (message: string, ...args: unknown[]) =>
      onError(args.find((arg) => arg instanceof Error) ?? new Error(message));
    diag.setLogger(
      {
        error: report,
        warn: report,
        info: () => {},
        debug: () => {},
        verbose: () => {},
      },
      DiagLogLevel.WARN,
    );
    // A span's children find it through the active context, which needs a
    // manager that follows async calls; without one each span is a trace.
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    return new LlmTracing(
      new TracerProvider({
        spanProcessors: [
          new PostHogSpanProcessor({
            projectToken: apiKey,
            host,
            client,
            privacyMode: !recordContent,
          }),
        ],
      }),
      recordContent,
    );
  }

  shutdown() {
    return this.provider.shutdown();
  }
}
