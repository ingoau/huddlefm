import { createHash } from "node:crypto";
import {
  capture as captureAnalytics,
  setPersonProperties,
} from "./analytics.ts";
import {
  scrobblingModes,
  type HuddleMixSource,
  type ScrobblingMode,
  type Store,
  type UserScrobbling,
} from "./store.ts";
import { logger } from "./logger.ts";

const lastFmEndpoint = "https://ws.audioscrobbler.com/2.0/";
const listenBrainzEndpoint = "https://api.listenbrainz.org/1";
const log = logger.child({ component: "scrobbling" });

export type ScrobbleTrack = {
  id: string;
  requesterId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  automatic?: boolean;
};

type Service = "lastfm" | "listenbrainz";
const services: Service[] = ["lastfm", "listenbrainz"];

class ScrobbleError extends Error {
  constructor(
    readonly service: Service,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }

  // The user's credentials no longer work, so the service is switched off.
  get authFailed() {
    return this.code === (this.service === "lastfm" ? 9 : 401);
  }

  get retryable() {
    return this.service === "lastfm"
      ? [11, 16, 29].includes(this.code)
      : this.code === 429 || this.code >= 500;
  }
}

export class ScrobbleDispatcher {
  private flushing = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private analyticsUsers = new Map<string, string>();

  constructor(
    private store: Store,
    private config: { lastFmApiKey?: string; lastFmSharedSecret?: string },
    private request = fetch,
  ) {}

  start() {
    void this.flush();
    this.timer = setInterval(() => void this.flush(), 60_000);
    log.info({ event: "started" }, "Scrobble dispatcher started");
  }

  async stop() {
    clearInterval(this.timer);
    await this.flushing;
    log.info({ event: "stopped" }, "Scrobble dispatcher stopped");
  }

  playback(sessionId: string, botUserId: string) {
    return new PlaybackScrobbler(this, sessionId, botUserId);
  }

  settings(userId: string, sessionId?: string) {
    const value = this.store.getUserScrobbling(userId);
    const lastFmConnected = Boolean(value.lastFmSessionKey);
    const listenBrainzConnected = Boolean(value.listenBrainzToken);
    return {
      lastFmAvailable: Boolean(
        this.config.lastFmApiKey && this.config.lastFmSharedSecret,
      ),
      lastFmConnected,
      lastFmUsername: value.lastFmUsername,
      lastFmEnabled: value.lastFmEnabled,
      listenBrainzConnected,
      listenBrainzUsername: value.listenBrainzUsername,
      listenBrainzEnabled: value.listenBrainzEnabled,
      huddleMixOptIn: value.huddleMixOptIn !== false,
      huddleMixSources: value.huddleMixSources,
      mode: value.mode,
      configured: lastFmConnected || listenBrainzConnected,
      enabledIntegration:
        (lastFmConnected && value.lastFmEnabled) ||
        (listenBrainzConnected && value.listenBrainzEnabled),
      ...(sessionId
        ? { sessionEnabled: this.sessionEnabled(sessionId, userId) }
        : {}),
    };
  }

  setMode(userId: string, mode: ScrobblingMode) {
    if (!scrobblingModes.includes(mode)) throw new Error("Invalid mode");
    this.store.setScrobblingMode(userId, mode);
    if (mode !== "always") this.store.clearPendingUserScrobbles(userId);
    this.changed(userId, "mode_changed", "Scrobbling mode changed", { mode });
  }

  setHuddleMixSources(userId: string, sources: readonly HuddleMixSource[]) {
    this.store.setHuddleMixSources(userId, sources);
    log.info(
      { event: "huddle_mix_sources_changed", userId, sources },
      "Huddle mix sources changed",
    );
  }

  sessionEnabled(sessionId: string, userId: string) {
    const override = this.store.getSessionScrobbling(sessionId, userId);
    return override ?? this.store.getUserScrobbling(userId).mode === "always";
  }

  shouldPrompt(sessionId: string, userId: string) {
    const settings = this.settings(userId);
    return (
      settings.mode === "ask" &&
      settings.enabledIntegration &&
      this.store.getSessionScrobbling(sessionId, userId) === undefined
    );
  }

  setSessionEnabled(sessionId: string, userId: string, enabled: boolean) {
    this.store.setSessionScrobbling(sessionId, userId, enabled);
    if (!enabled) this.store.clearPendingSessionScrobbles(sessionId, userId);
    log.info(
      { event: "session_setting_changed", sessionId, userId, enabled },
      "Session scrobbling setting changed",
    );
    captureAnalytics("scrobbling.session_setting_changed", {
      distinctId: userId,
      sessionId,
      properties: { enabled },
    });
  }

  async beginLastFm(userId: string) {
    const token = String((await this.lastFm("auth.getToken")).token ?? "");
    if (!token) throw new Error("Last.fm returned no authentication token");
    this.store.setLastFmPending(userId, token, Date.now());
    log.info(
      { event: "lastfm_auth_started", userId },
      "Last.fm authorization started",
    );
    captureAnalytics("scrobbling.lastfm_auth_started", {
      distinctId: userId,
    });
    return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(this.config.lastFmApiKey!)}&token=${encodeURIComponent(token)}`;
  }

  async finishLastFm(userId: string) {
    const pending = this.store.getUserScrobbling(userId);
    if (
      !pending.lastFmPendingToken ||
      !pending.lastFmPendingAt ||
      Date.now() - pending.lastFmPendingAt > 60 * 60_000
    )
      throw new Error("Last.fm login expired; start again");
    const result = await this.lastFm("auth.getSession", {
      token: pending.lastFmPendingToken,
    });
    const session = result.session as
      { key?: string; name?: string } | undefined;
    if (!session?.key || !session.name)
      throw new Error("Last.fm returned no session");
    this.store.connectLastFm(userId, session.name, session.key);
    this.changed(userId, "lastfm_connected", "Last.fm connected");
    return session.name;
  }

  disconnectLastFm(userId: string) {
    this.store.disconnectLastFm(userId);
    this.store.clearPendingScrobbles(userId, "lastfm");
    this.changed(userId, "lastfm_disconnected", "Last.fm disconnected");
  }

  setLastFmEnabled(userId: string, enabled: boolean) {
    const settings = this.store.getUserScrobbling(userId);
    if (enabled && !settings.lastFmSessionKey)
      throw new Error("Connect Last.fm before enabling scrobbling");
    this.store.setLastFmEnabled(userId, enabled);
    if (!enabled) this.store.clearPendingScrobbles(userId, "lastfm");
    this.changed(
      userId,
      "lastfm_setting_changed",
      "Last.fm scrobbling setting changed",
      { enabled },
    );
  }

  async setListenBrainz(
    userId: string,
    token: string | undefined,
    enabled: boolean,
  ) {
    const current = this.store.getUserScrobbling(userId);
    let username = current.listenBrainzUsername;
    if (token) {
      const response = await this.request(
        `${listenBrainzEndpoint}/validate-token`,
        {
          headers: { authorization: `Token ${token}` },
        },
      );
      const result = (await response.json()) as {
        valid?: boolean;
        user_name?: string;
      };
      if (!response.ok || !result.valid || !result.user_name)
        throw new Error("That ListenBrainz user token is invalid");
      username = result.user_name;
      this.store.setListenBrainzToken(userId, token, username);
    }
    if (enabled && !(token || current.listenBrainzToken))
      throw new Error(
        "Enter a ListenBrainz user token before enabling scrobbling",
      );
    this.store.setListenBrainzEnabled(userId, enabled);
    if (!enabled) this.store.clearPendingScrobbles(userId, "listenbrainz");
    this.changed(
      userId,
      "listenbrainz_setting_changed",
      "ListenBrainz setting changed",
      { enabled, connected: Boolean(username) },
    );
    return username;
  }

  disconnectListenBrainz(userId: string) {
    this.store.disconnectListenBrainz(userId);
    this.store.clearPendingScrobbles(userId, "listenbrainz");
    this.changed(
      userId,
      "listenbrainz_disconnected",
      "ListenBrainz disconnected",
    );
  }

  syncAnalyticsUser(userId: string) {
    const settings = this.settings(userId);
    const properties = {
      lastfm_connected: settings.lastFmConnected,
      lastfm_enabled: settings.lastFmEnabled,
      listenbrainz_connected: settings.listenBrainzConnected,
      listenbrainz_enabled: settings.listenBrainzEnabled,
      scrobbling_mode: settings.mode,
    };
    const snapshot = JSON.stringify(properties);
    if (this.analyticsUsers.get(userId) === snapshot) return;
    this.analyticsUsers.set(userId, snapshot);
    setPersonProperties(userId, properties);
  }

  private changed(
    userId: string,
    event: string,
    text: string,
    properties?: Record<string, unknown>,
  ) {
    log.info({ event, userId, ...properties }, text);
    captureAnalytics(`scrobbling.${event}`, {
      distinctId: userId,
      ...(properties ? { properties } : {}),
    });
    this.syncAnalyticsUser(userId);
  }

  nowPlaying(userIds: Iterable<string>, track: ScrobbleTrack) {
    for (const userId of userIds)
      void this.sendNowPlaying(userId, track).catch((error) =>
        log.warn(
          {
            event: "now_playing_failed",
            userId,
            trackId: track.id,
            err: error,
          },
          "Now-playing submission failed",
        ),
      );
  }

  // The Huddle mix remembers what each listener actually heard, so it does not
  // serve them the same songs the next time they are in a Huddle. This is the
  // same threshold a scrobble uses, and it is recorded whether or not the
  // listener scrobbles \u2014 but never for someone who opted out of the mix.
  private rememberListen(
    sessionId: string,
    userId: string,
    track: ScrobbleTrack,
    listenedAt: number,
  ) {
    if (this.store.getUserScrobbling(userId).huddleMixOptIn === false) return;
    this.store.recordTrackPlay({
      sessionId,
      userId,
      title: track.title,
      artist: track.artist,
      playedAt: listenedAt * 1000,
    });
  }

  reached(
    sessionId: string,
    userId: string,
    track: ScrobbleTrack,
    listenedAt: number,
    listenedSeconds: number,
  ) {
    const threshold = track.duration ? Math.min(track.duration / 2, 240) : 240;
    if (listenedSeconds < threshold) return false;
    this.rememberListen(sessionId, userId, track, listenedAt);
    if (!this.sessionEnabled(sessionId, userId)) return true;
    const settings = this.store.getUserScrobbling(userId);
    const lastFm = enabled(settings, "lastfm");
    const listenBrainz = enabled(settings, "listenbrainz");
    const queue = (service: Service) =>
      this.store.queueScrobble(
        sessionId,
        track.id,
        userId,
        service,
        listenedAt,
        track,
      );
    if (lastFm && (track.duration === undefined || track.duration > 30))
      queue("lastfm");
    if (listenBrainz) queue("listenbrainz");
    log.debug(
      {
        event: "eligible_listen_queued",
        sessionId,
        userId,
        trackId: track.id,
        lastFm,
        listenBrainz,
      },
      "Eligible listen queued",
    );
    void this.flush();
    return true;
  }

  flush() {
    const next = this.flushing.then(
      () => this.flushPending(),
      () => this.flushPending(),
    );
    this.flushing = next.catch(() => undefined);
    return next;
  }

  private async sendNowPlaying(userId: string, track: ScrobbleTrack) {
    const settings = this.store.getUserScrobbling(userId);
    const errors: unknown[] = [];
    for (const service of services) {
      if (!enabled(settings, service)) continue;
      try {
        await this.submit(service, settings, track);
      } catch (error) {
        if (error instanceof ScrobbleError && error.authFailed)
          void this.revoke(service, userId);
        errors.push(error);
      }
    }
    if (errors.length) throw errors[0];
  }

  // Switches a service off once its credentials stop working.
  private async revoke(service: Service, userId: string) {
    if (service === "lastfm") this.disconnectLastFm(userId);
    else await this.setListenBrainz(userId, undefined, false);
  }

  private async flushPending() {
    const pending = this.store.pendingScrobbles(Date.now());
    if (pending.length)
      log.debug(
        { event: "flush_started", count: pending.length },
        "Flushing pending scrobbles",
      );
    for (const item of pending) {
      const settings = this.store.getUserScrobbling(item.userId);
      const service: Service =
        item.service === "lastfm" ? "lastfm" : "listenbrainz";
      try {
        if (!this.sessionEnabled(item.sessionId, item.userId)) continue;
        if (!enabled(settings, service)) continue;
        await this.submit(service, settings, item.track, item.listenedAt);
        this.store.finishScrobble(item.id, "sent");
        log.info(
          {
            event: "submission_sent",
            service: item.service,
            sessionId: item.sessionId,
            userId: item.userId,
            trackId: item.track.id,
            attempts: item.attempts + 1,
          },
          "Scrobble submitted",
        );
      } catch (error) {
        if (error instanceof ScrobbleError && error.authFailed) {
          await this.revoke(service, item.userId);
          continue;
        }
        const retry = !(error instanceof ScrobbleError) || error.retryable;
        if (retry)
          this.store.retryScrobble(
            item.id,
            item.attempts + 1,
            Date.now() + Math.min(3_600_000, 30_000 * 2 ** item.attempts),
          );
        else this.store.finishScrobble(item.id, "failed");
        log.error(
          {
            event: "submission_failed",
            service: item.service,
            sessionId: item.sessionId,
            userId: item.userId,
            trackId: item.track.id,
            attempts: item.attempts + 1,
            retry,
            err: error,
          },
          "Scrobble submission failed",
        );
        if (retry) break;
      }
    }
  }

  // Sends a now-playing update, or a scrobble when `listenedAt` is given.
  private async submit(
    service: Service,
    settings: UserScrobbling,
    track: ScrobbleTrack,
    listenedAt?: number,
  ) {
    if (service === "listenbrainz")
      return this.listenBrainz(
        settings.listenBrainzToken!,
        listenedAt === undefined ? "playing_now" : "single",
        track,
        listenedAt,
      );
    const params = trackParams(track, settings.lastFmSessionKey!);
    if (listenedAt === undefined) {
      await this.lastFm("track.updateNowPlaying", params);
      return;
    }
    const result = await this.lastFm("track.scrobble", {
      ...params,
      timestamp: String(listenedAt),
      ...(track.automatic ? { chosenByUser: "0" } : {}),
    });
    const scrobbles = result.scrobbles as
      { "@attr"?: { ignored?: number | string } } | undefined;
    if (Number(scrobbles?.["@attr"]?.ignored))
      throw new ScrobbleError("lastfm", 0, "Last.fm ignored the scrobble");
  }

  private async lastFm(method: string, params: Record<string, string> = {}) {
    if (!this.config.lastFmApiKey || !this.config.lastFmSharedSecret)
      throw new Error("Last.fm is not configured");
    const signed = { api_key: this.config.lastFmApiKey, method, ...params };
    const signature =
      Object.entries(signed)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => key + value)
        .join("") + this.config.lastFmSharedSecret;
    const response = await this.request(lastFmEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({
        ...signed,
        api_sig: createHash("md5").update(signature, "utf8").digest("hex"),
        format: "json",
      }),
    });
    const result = (await response.json()) as Record<string, unknown> & {
      error?: number;
      message?: string;
    };
    if (!response.ok || result.error)
      throw new ScrobbleError(
        "lastfm",
        result.error ?? response.status,
        result.message ?? `HTTP ${response.status}`,
      );
    return result;
  }

  private async listenBrainz(
    token: string,
    listenType: "single" | "playing_now",
    track: ScrobbleTrack,
    listenedAt?: number,
  ) {
    const response = await this.request(
      `${listenBrainzEndpoint}/submit-listens`,
      {
        method: "POST",
        headers: {
          authorization: `Token ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          listen_type: listenType,
          payload: [
            {
              ...(listenedAt === undefined ? {} : { listened_at: listenedAt }),
              track_metadata: {
                artist_name: track.artist,
                track_name: track.title,
                ...(track.album ? { release_name: track.album } : {}),
                additional_info: {
                  submission_client: "HuddleFM",
                  ...(track.duration
                    ? { duration_ms: track.duration * 1000 }
                    : {}),
                },
              },
            },
          ],
        }),
      },
    );
    if (!response.ok)
      throw new ScrobbleError(
        "listenbrainz",
        response.status,
        `ListenBrainz HTTP ${response.status}`,
      );
  }
}

type Listener = {
  listenedAt: number;
  seconds: number;
  active: boolean;
  reported?: boolean;
};

export class PlaybackScrobbler {
  private current?: {
    track: ScrobbleTrack;
    playing: boolean;
    lastPosition: number;
    listeners: Map<string, Listener>;
  };

  constructor(
    private dispatcher: ScrobbleDispatcher,
    private sessionId: string,
    private botUserId: string,
  ) {}

  start(
    track: ScrobbleTrack,
    userIds: Iterable<string>,
    playing = true,
    position = 0,
  ) {
    const listeners = new Map<string, Listener>();
    for (const userId of userIds)
      if (userId !== this.botUserId) listeners.set(userId, newListener());
    this.current = { track, playing, lastPosition: position, listeners };
    this.announce(listeners.keys());
  }

  memberJoined(userId: string) {
    if (!this.current || userId === this.botUserId) return;
    const existing = this.current.listeners.get(userId);
    if (existing?.active) return;
    if (existing) existing.active = true;
    else this.current.listeners.set(userId, newListener());
    this.announce([userId]);
  }

  memberLeft(userId: string) {
    const listener = this.current?.listeners.get(userId);
    if (listener) listener.active = false;
  }

  pause() {
    if (this.current) this.current.playing = false;
  }

  resume() {
    if (!this.current) return;
    this.current.playing = true;
    this.announce(this.current.listeners.keys());
  }

  sessionEnabled(userId: string) {
    const listener = this.current?.listeners.get(userId);
    if (listener) {
      listener.listenedAt = Math.floor(Date.now() / 1000);
      listener.seconds = 0;
    }
    this.settingsEnabled(userId);
  }

  settingsEnabled(userId: string) {
    const listener = this.current?.listeners.get(userId);
    if (listener) listener.reported = false;
    this.announce([userId]);
  }

  position(seconds: number) {
    if (!this.current) return;
    const delta = seconds - this.current.lastPosition;
    this.current.lastPosition = seconds;
    if (!this.current.playing || delta < 0 || delta > 5) return;
    for (const [userId, listener] of this.current.listeners) {
      if (!listener.active || listener.reported) continue;
      listener.seconds += delta;
      listener.reported = this.dispatcher.reached(
        this.sessionId,
        userId,
        this.current.track,
        listener.listenedAt,
        listener.seconds,
      );
    }
  }

  finish() {
    this.current = undefined;
  }

  // Tells the listeners who scrobble here what is playing, if anything is.
  private announce(userIds: Iterable<string>) {
    if (!this.current?.playing) return;
    const enabled = [...userIds].filter((userId) =>
      this.dispatcher.sessionEnabled(this.sessionId, userId),
    );
    this.dispatcher.nowPlaying(enabled, this.current.track);
  }
}

function newListener(): Listener {
  return {
    listenedAt: Math.floor(Date.now() / 1000),
    seconds: 0,
    active: true,
  };
}

function enabled(settings: UserScrobbling, service: Service) {
  return service === "lastfm"
    ? Boolean(settings.lastFmEnabled && settings.lastFmSessionKey)
    : Boolean(settings.listenBrainzEnabled && settings.listenBrainzToken);
}

function trackParams(track: ScrobbleTrack, sessionKey: string) {
  return {
    artist: track.artist,
    track: track.title,
    ...(track.album ? { album: track.album } : {}),
    ...(track.duration ? { duration: String(Math.round(track.duration)) } : {}),
    sk: sessionKey,
  };
}
