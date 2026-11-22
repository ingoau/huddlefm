package huddlefm.android;

import android.os.SystemClock;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * HuddleFM's side of the huddle data channel, as docs/data-channel.md describes it, ported from
 * clients/core/protocol.ts. Runs on the main thread: Channel hands it messages there.
 */
final class Client {
  static final String TOPIC = "huddlefm";
  static final int VERSION = 1;
  static final int PROTOCOL = 1;
  /** Chime refuses data messages larger than this. */
  private static final int MAX_BYTES = 2048;
  private static final long REQUEST_TIMEOUT_MS = 15_000;
  private static final long CHUNK_TIMEOUT_MS = 5_000;
  private static final long SYNC_RETRY_MS = 4_000;
  private static final int SYNC_RETRIES = 3;
  /** Quiet this long, and the client pings the bot to see it's still there. */
  private static final long QUIET_MS = 20_000;
  /** Quiet this long, and the bot is taken to have gone. */
  private static final long GONE_MS = 45_000;

  enum Presence {
    /** not in a huddle */
    OFFLINE,
    /** in a huddle, and the bot hasn't answered */
    WAITING,
    /** the bot answered */
    CONNECTED,
    /** the bot speaks a protocol this client doesn't */
    INCOMPATIBLE
  }

  interface Sender {
    void send(byte[] data) throws Exception;
  }

  interface Callback {
    void done(JSONObject result);
  }

  interface SelfUser {
    String get();
  }

  private static final class Pending {
    final Callback callback;
    final Runnable timeout;
    final String type;

    Pending(Callback callback, Runnable timeout, String type) {
      this.callback = callback;
      this.timeout = timeout;
      this.type = type;
    }
  }

  private static final class Chunks {
    final String[] parts;
    final Runnable timeout;

    Chunks(int n, Runnable timeout) {
      parts = new String[n];
      this.timeout = timeout;
    }
  }

  Presence presence = Presence.OFFLINE;
  /** The latest session, as the bot sent it. */
  JSONObject state;
  /** What this user may do, and their own settings. */
  JSONObject you;
  /** When the latest state arrived, by uptime. */
  long receivedAt;
  /** The bot's Slack user, once it has sent state. */
  String botUserId;

  private final List<Runnable> listeners = new CopyOnWriteArrayList<>();
  private final Map<String, Pending> pending = new HashMap<>();
  private final Map<String, Chunks> chunks = new HashMap<>();
  private Sender sender;
  private SelfUser self = () -> null;
  private String botAttendee;
  private Runnable syncTimer;
  private long heardAt;
  private final Runnable watch = this::watch;
  /** Whether the bot's latest state counted this user among the huddle's participants. */
  private boolean seenHere;
  private Seal seal;
  private String key;

  Client() {
    try {
      seal = new Seal();
      key = seal.publicKey();
    } catch (Exception e) {
      HuddleFM.log("Can't seal: " + e);
    }
  }

  void listen(Runnable listener) {
    listeners.add(listener);
  }

  void unlisten(Runnable listener) {
    listeners.remove(listener);
  }

  private void changed() {
    for (Runnable listener : listeners) {
      try {
        listener.run();
      } catch (Throwable t) {
        HuddleFM.log("A listener failed: " + t);
      }
    }
  }

  String selfUserId() {
    return self.get();
  }

  /** The huddle's data channel opened, with a way to send on it. */
  void connect(Sender sender, SelfUser self) {
    // another huddle's channel: nothing of the last session carries over
    forget();
    this.sender = sender;
    this.self = self;
    presence = Presence.WAITING;
    HuddleFM.main.removeCallbacks(watch);
    HuddleFM.main.postDelayed(watch, QUIET_MS / 2);
    sync(0);
    changed();
  }

  /** The data channel closed. */
  void disconnect() {
    sender = null;
    HuddleFM.main.removeCallbacks(watch);
    forget();
    presence = Presence.OFFLINE;
    changed();
  }

  private void forget() {
    botAttendee = null;
    botUserId = null;
    if (syncTimer != null) HuddleFM.main.removeCallbacks(syncTimer);
    for (Chunks c : chunks.values()) HuddleFM.main.removeCallbacks(c.timeout);
    chunks.clear();
    settleAll(result(false, "disconnected", "Not connected to the huddle."));
    state = null;
    you = null;
    seenHere = false;
  }

  private void settleAll(JSONObject result) {
    List<Pending> all = new ArrayList<>(pending.values());
    pending.clear();
    for (Pending p : all) {
      HuddleFM.main.removeCallbacks(p.timeout);
      p.callback.done(result);
    }
  }

  /** A bot that crashed or was removed says nothing more, so a quiet one is pinged, then gone. */
  private void watch() {
    if (sender != null) HuddleFM.main.postDelayed(watch, QUIET_MS / 2);
    if (presence != Presence.CONNECTED) return;
    long quiet = SystemClock.uptimeMillis() - heardAt;
    if (quiet > GONE_MS) {
      HuddleFM.log("HuddleFM stopped answering");
      closeSession();
    } else if (quiet > QUIET_MS) post(object("type", "ping"));
  }

  /**
   * Whether a message is the bot's. Chime stamps each with its sender's Slack user, so once the
   * bot's user is known only it is believed; before that, whoever sends state first is.
   */
  private boolean fromBot(String attendeeId, String userId) {
    // the bot heard in this session, else the one last heard in this workspace's huddles
    String bot = botUserId != null ? botUserId : Invite.bot();
    if (bot != null) return bot.equals(userId);
    return botAttendee == null || botAttendee.equals(attendeeId);
  }

  /** The playback position now, counting time since the state arrived, in seconds. */
  double position() {
    if (state == null) return 0;
    JSONObject session = state.optJSONObject("session");
    if (session == null) return 0;
    double position = session.optDouble("position", 0);
    if (!"playing".equals(session.optString("state"))) return position;
    double at = position + (SystemClock.uptimeMillis() - receivedAt) / 1000.0;
    JSONObject now = state.optJSONObject("nowPlaying");
    double duration = now == null ? 0 : now.optDouble("duration", 0);
    return duration > 0 ? Math.min(at, duration) : at;
  }

  /** Seeks, showing it straight away rather than once the bot's state follows. */
  void seek(double seconds, Callback callback) {
    JSONObject before = state;
    if (before == null) {
      callback.done(result(false, "idle", "HuddleFM isn't playing."));
      return;
    }
    long beforeAt = receivedAt;
    try {
      JSONObject next = new JSONObject(before.toString());
      next.getJSONObject("session").put("position", seconds);
      receivedAt = SystemClock.uptimeMillis();
      state = next;
      changed();
    } catch (Exception ignored) {
    }
    final int seq = before.optInt("seq");
    command(
        object("type", "seek", "to", seconds),
        result -> {
          // unless a newer state has come since, the one before is still the truth
          if (!result.optBoolean("ok") && state != null && state.optInt("seq") == seq) {
            receivedAt = beforeAt;
            state = before;
            changed();
          }
          callback.done(result);
        });
  }

  /** Does what a player button or dialog does, as docs/data-channel.md lists them. */
  void command(JSONObject command, Callback callback) {
    request(object("type", "command", "command", command), command.optString("type"), callback);
  }

  /** Changes one setting. */
  void setting(String id, Object value, Callback callback) {
    request(object("type", "setting", "setting", id, "value", value), "setting", callback);
  }

  /** Applies a permission preset. */
  void preset(String preset, Callback callback) {
    request(
        object("type", "setting", "setting", "permissions", "preset", preset), "setting", callback);
  }

  void receive(byte[] data, String attendeeId, String externalUserId, boolean throttled) {
    if (throttled) {
      HuddleFM.log("Chime throttled a message this client sent");
      return;
    }
    JSONObject payload;
    try {
      payload = new JSONObject(new String(data, StandardCharsets.UTF_8));
    } catch (Exception e) {
      return;
    }
    if (payload.optInt("v") != VERSION || !(payload.opt("type") instanceof String)) return;
    String userId = slackUserId(externalUserId);
    if ("chunk".equals(payload.optString("type"))) receiveChunk(attendeeId, userId, payload);
    else handle(attendeeId, userId, payload);
  }

  /** The Slack user behind a Chime external user id, `<prefix>-<call>-<user>`. */
  static String slackUserId(String externalUserId) {
    if (externalUserId == null) return null;
    String[] parts = externalUserId.split("-");
    String user = parts.length == 3 || parts.length == 4 ? parts[2] : "";
    return user.matches("^[UW][A-Z0-9]+$") ? user : null;
  }

  private void handle(String attendeeId, String userId, JSONObject payload) {
    Object to = payload.opt("to");
    if (to instanceof String && !to.equals(selfUserId())) return;
    if (!fromBot(attendeeId, userId)) return;
    heardAt = SystemClock.uptimeMillis();
    switch (payload.optString("type")) {
      case "hello":
        botAttendee = attendeeId;
        botUserId = userId;
        if (payload.optInt("protocol") != PROTOCOL) {
          HuddleFM.log("HuddleFM speaks protocol " + payload.opt("protocol"));
          presence = Presence.INCOMPATIBLE;
          changed();
          return;
        }
        // a bot that restarted counts its states from the start again
        state = null;
        you = null;
        presence = Presence.WAITING;
        sync(0);
        changed();
        return;
      case "state":
        {
          JSONObject session = payload.optJSONObject("session");
          if (!(payload.opt("seq") instanceof Number) || session == null || !(session.opt("state") instanceof String)) return;
          botAttendee = attendeeId;
          botUserId = userId;
          if (state != null && payload.optInt("seq") < state.optInt("seq")) return;
          if (syncTimer != null) HuddleFM.main.removeCallbacks(syncTimer);
          String playback = session.optString("state");
          // the bot's last word before it stops answering
          if ("ended".equals(playback) || "suspended".equals(playback)) {
            closeSession();
            return;
          }
          receivedAt = SystemClock.uptimeMillis();
          if (presence != Presence.INCOMPATIBLE) presence = Presence.CONNECTED;
          Invite.remember(userId);
          state = payload;
          // what the bot says this user may do, it says to those it sees in the huddle: one that
          // synced before the bot saw them join asks again once it does
          boolean here = strings(payload.optJSONArray("participants")).contains(selfUserId());
          boolean joined = here && !seenHere;
          seenHere = here;
          changed();
          if (joined) sync(0);
          return;
        }
      case "you":
        you = payload;
        changed();
        return;
      case "sealed":
        {
          if (seal == null) return;
          String inner =
              seal.open(payload.optString("key"), payload.optString("iv"), payload.optString("data"));
          if (inner == null) return;
          try {
            JSONObject message = new JSONObject(inner);
            if (message.optInt("v") != VERSION
                || "sealed".equals(message.optString("type"))
                || !message.optString("to").equals(selfUserId())) return;
            handle(attendeeId, userId, message);
          } catch (Exception e) {
            HuddleFM.log("Couldn't open a message: " + e);
          }
          return;
        }
      case "resync":
        // the bot doesn't know this client, so what's for this user has nowhere sealed to go
        sync(0);
        return;
      case "result":
        {
          Pending request = pending.remove(String.valueOf(payload.opt("id")));
          if (request == null) return;
          HuddleFM.main.removeCallbacks(request.timeout);
          request.callback.done(payload);
          return;
        }
      default:
    }
  }

  /** Forgets the session the bot has left, and settles what was waiting. */
  private void closeSession() {
    List<Pending> all = new ArrayList<>(pending.values());
    pending.clear();
    for (Pending p : all) {
      HuddleFM.main.removeCallbacks(p.timeout);
      // ending it was the last thing the bot did, before it could answer
      p.callback.done(
          "end".equals(p.type)
              ? result(true, null, null)
              : result(false, "ended", "The session ended."));
    }
    botAttendee = null;
    botUserId = null;
    state = null;
    you = null;
    if (sender != null) presence = Presence.WAITING;
    changed();
  }

  private void receiveChunk(String attendeeId, String userId, JSONObject payload) {
    Object id = payload.opt("id");
    Object i = payload.opt("i");
    Object n = payload.opt("n");
    Object data = payload.opt("data");
    if (!(id instanceof String)
        || !(i instanceof Number)
        || !(n instanceof Number)
        || !(data instanceof String)) return;
    int index = ((Number) i).intValue();
    int count = ((Number) n).intValue();
    if (index < 0 || index >= count || count > 64) return;
    // only the bot's are put together, so no one else can make clients wait
    if (!fromBot(attendeeId, userId)) return;
    String key = attendeeId + "/" + id;
    Chunks entry = chunks.get(key);
    if (entry == null) {
      Runnable timeout =
          () -> {
            chunks.remove(key);
            HuddleFM.log("A message from HuddleFM arrived incomplete");
            sync(0);
          };
      entry = new Chunks(count, timeout);
      chunks.put(key, entry);
      HuddleFM.main.postDelayed(timeout, CHUNK_TIMEOUT_MS);
    }
    if (entry.parts.length != count) return;
    entry.parts[index] = (String) data;
    StringBuilder whole = new StringBuilder();
    for (String part : entry.parts) {
      if (part == null) return;
      whole.append(part);
    }
    HuddleFM.main.removeCallbacks(entry.timeout);
    chunks.remove(key);
    try {
      JSONObject message = new JSONObject(whole.toString());
      if (message.optInt("v") == VERSION && message.opt("type") instanceof String)
        handle(attendeeId, userId, message);
    } catch (Exception ignored) {
    }
  }

  /** Asks the bot for the session, again a few times while it doesn't answer. */
  private void sync(int attempt) {
    if (syncTimer != null) HuddleFM.main.removeCallbacks(syncTimer);
    if (sender == null) return;
    JSONObject message = object("type", "sync");
    if (key != null) put(message, "key", key);
    if (!post(message)) return;
    if (attempt + 1 >= SYNC_RETRIES) return;
    syncTimer =
        () -> {
          if (presence == Presence.WAITING) sync(attempt + 1);
        };
    HuddleFM.main.postDelayed(syncTimer, SYNC_RETRY_MS);
  }

  private void request(JSONObject body, String type, Callback callback) {
    String id = Long.toString(Double.doubleToLongBits(Math.random()) & 0xffffffffffL, 36);
    Runnable timeout =
        () -> {
          if (pending.remove(id) != null)
            callback.done(result(false, "timeout", "HuddleFM didn't answer."));
        };
    pending.put(id, new Pending(callback, timeout, type));
    put(body, "id", id);
    if (!post(body)) {
      pending.remove(id);
      callback.done(result(false, "offline", "Not connected to the huddle."));
      return;
    }
    HuddleFM.main.postDelayed(timeout, REQUEST_TIMEOUT_MS);
  }

  private boolean post(JSONObject payload) {
    if (sender == null) return false;
    put(payload, "v", VERSION);
    byte[] data = payload.toString().getBytes(StandardCharsets.UTF_8);
    if (data.length > MAX_BYTES) {
      HuddleFM.log("Couldn't send " + payload.optString("type") + ": it's too large");
      return false;
    }
    try {
      sender.send(data);
      return true;
    } catch (Throwable t) {
      HuddleFM.log("Couldn't send " + payload.optString("type") + ": " + t);
      return false;
    }
  }

  // --- what the panel asks of the state

  JSONObject session() {
    return state == null ? null : state.optJSONObject("session");
  }

  JSONObject nowPlaying() {
    return state == null ? null : state.optJSONObject("nowPlaying");
  }

  /** Whether the user may do something; until the bot says, everything is allowed. */
  boolean can(String capability) {
    if (you == null) return true;
    JSONArray capabilities = you.optJSONArray("capabilities");
    if (capabilities == null) return false;
    for (int i = 0; i < capabilities.length(); i++)
      if (capability.equals(capabilities.optString(i))) return true;
    return false;
  }

  boolean admin() {
    return you != null && you.optBoolean("admin");
  }

  // --- JSON helpers

  static JSONObject object(Object... pairs) {
    JSONObject o = new JSONObject();
    for (int i = 0; i + 1 < pairs.length; i += 2) put(o, (String) pairs[i], pairs[i + 1]);
    return o;
  }

  static void put(JSONObject o, String key, Object value) {
    try {
      o.put(key, value == null ? JSONObject.NULL : value);
    } catch (Exception ignored) {
    }
  }

  static JSONObject result(boolean ok, String error, String message) {
    JSONObject r = object("ok", ok);
    if (error != null) put(r, "error", error);
    if (message != null) put(r, "message", message);
    return r;
  }

  static List<JSONObject> list(JSONArray array) {
    List<JSONObject> out = new ArrayList<>();
    if (array == null) return out;
    for (int i = 0; i < array.length(); i++) {
      JSONObject o = array.optJSONObject(i);
      if (o != null) out.add(o);
    }
    return out;
  }

  static List<String> strings(JSONArray array) {
    List<String> out = new ArrayList<>();
    if (array == null) return out;
    for (int i = 0; i < array.length(); i++) out.add(array.optString(i));
    return out;
  }
}
