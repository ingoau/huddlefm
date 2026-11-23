import { OpenTelemetry } from "@ai-sdk/otel";
import { context, diag, DiagLogLevel } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { PostHogSpanProcessor } from "@posthog/ai/otel";
import type { PostHog } from "posthog-node";

/**
 * Sends the AI agent's traces to PostHog's LLM analytics: each run, its model
 * calls with their latency, tokens and cost, and its tool calls. Like the
 * rest of HuddleFM's analytics it leaves out what people wrote: the prompt,
 * the replies and tool arguments are never sent (privacy mode). A run is
 * credited to whoever is in the PostHog client's context when it starts, so
 * the agent runs inside `client.withContext`.
 */
export class LlmTracing {
  readonly telemetry: OpenTelemetry;

  private constructor(private provider: TracerProvider) {
    this.telemetry = new OpenTelemetry({
      tracer: provider.getTracer("huddlefm"),
    });
  }

  static create(
    apiKey: string,
    host: string | undefined,
    client: Pick<PostHog, "getContext">,
    onError: (error: unknown) => void = () => {},
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
            privacyMode: true,
          }),
        ],
      }),
    );
  }

  shutdown() {
    return this.provider.shutdown();
  }
}
