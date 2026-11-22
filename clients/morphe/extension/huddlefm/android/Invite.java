package huddlefm.android;

import android.content.Context;
import android.content.SharedPreferences;
import java.lang.ref.WeakReference;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlin.coroutines.jvm.internal.ContinuationImpl;
import slack.services.calls.service.backend.HuddleInviteesManagerImpl;

/**
 * Starts HuddleFM: invites the HuddleFM last heard in a huddle of this workspace to the huddle the
 * user is in, as the huddle's Invite people does, through Slack's own invitees manager.
 */
public final class Invite {
  private static WeakReference<Object> manager = new WeakReference<>(null);
  /** The workspace of the huddle the user is in. */
  static volatile String teamId;

  private Invite() {}

  /** Slack made its invitees manager, which it keeps for the app's life. */
  public static void manager(Object invitees) {
    manager = new WeakReference<>(invitees);
  }

  interface Done {
    void done(boolean ok, String error);
  }

  private static SharedPreferences prefs() {
    return HuddleFM.context().getSharedPreferences("huddlefm", Context.MODE_PRIVATE);
  }

  /** Remembers the bot heard in this workspace's huddle, for inviting it to the next one. */
  static void remember(String botUserId) {
    String team = teamId;
    if (team == null || botUserId == null || HuddleFM.context() == null) return;
    if (botUserId.equals(bot())) return;
    prefs().edit().putString("bot." + team, botUserId).apply();
  }

  /** The HuddleFM last heard in a huddle of this workspace, or null. */
  static String bot() {
    String team = teamId;
    if (team == null || HuddleFM.context() == null) return null;
    return prefs().getString("bot." + team, null);
  }

  /** Whether HuddleFM can be invited from the panel. */
  static boolean possible() {
    return manager.get() != null && Channel.channelId != null && bot() != null;
  }

  static void invite(Done done) {
    Object invitees = manager.get();
    String channel = Channel.channelId;
    String bot = bot();
    if (invitees == null || channel == null || bot == null) {
      done.done(false, "unavailable");
      return;
    }
    Continuation<Object> end =
        new Continuation<Object>() {
          @Override
          public CoroutineContext getContext() {
            return EmptyCoroutineContext.INSTANCE;
          }

          @Override
          public void resumeWith(Object result) {}
        };
    ContinuationImpl callback =
        new ContinuationImpl(end) {
          @Override
          protected Object invokeSuspend(Object result) {
            finish(result, done);
            return result;
          }
        };
    try {
      Object result = ((HuddleInviteesManagerImpl) invitees).inviteUserToHuddle(channel, bot, callback);
      // COROUTINE_SUSPENDED is an enum constant: the answer comes to the callback later
      if (!(result instanceof Enum)) finish(result, done);
    } catch (Throwable t) {
      HuddleFM.log("Couldn't invite HuddleFM: " + t);
      done.done(false, t.toString());
    }
  }

  private static void finish(Object result, Done done) {
    String name = result == null ? "null" : result.getClass().getName();
    boolean ok = name.endsWith("$Success");
    HuddleFM.log("Inviting HuddleFM: " + name);
    HuddleFM.main.post(() -> done.done(ok, ok ? null : name));
  }
}
