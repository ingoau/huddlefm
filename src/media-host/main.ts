// The media host's entry point: `bun run media-host`. It runs the huddles'
// media processes for a Slack app in another container; see host.ts.
//
// The app writes the log file, so the host only logs to stdout unless told
// otherwise.
process.env.LOG_FILE ??= "";
const { logger, flushLogs } = await import("../logger.ts");
const { MediaHost } = await import("./host.ts");

const log = logger.child({ component: "media-host" });
const directory = process.env.MEDIA_HOST_DIR || "data/run";
const orphanMinutes = Number(process.env.MEDIA_HOST_ORPHAN_MINUTES ?? 10);
const host = new MediaHost(directory, {
  orphanMs:
    Number.isFinite(orphanMinutes) && orphanMinutes > 0
      ? orphanMinutes * 60_000
      : undefined,
});
await host.listen();

let stopping = false;
const stop = async () => {
  if (stopping) process.exit(1);
  stopping = true;
  log.info(
    { event: "media_host_stopping", sessions: host.size },
    "Media host stopping; its media processes leave their huddles",
  );
  await Promise.race([host.stop(), Bun.sleep(20_000)]);
  flushLogs();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
