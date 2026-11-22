package huddlefm.android;

import com.amazonaws.services.chime.sdk.meetings.realtime.datamessage.DataMessage;
import com.amazonaws.services.chime.sdk.meetings.realtime.datamessage.DataMessageObserver;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * The huddle's Chime data channel. Slack's huddle session (ChimeMeetingSessionImpl) listens on its
 * own topic once the huddle's audio starts; the patch calls {@link #attach} then, and this listens
 * on HuddleFM's topic through the same Chime facade and sends on it.
 */
public final class Channel {
  private static WeakReference<Object> session = new WeakReference<>(null);
  private static Object facade;
  private static Method send;

  private static final DataMessageObserver observer =
      new DataMessageObserver() {
        @Override
        public void onDataMessageReceived(DataMessage message) {
          if (!Client.TOPIC.equals(message.topic)) return;
          final byte[] data = message.data;
          final String attendee = message.senderAttendeeId;
          final String external = message.senderExternalUserId;
          final boolean throttled = message.throttled;
          HuddleFM.main.post(() -> HuddleFM.client.receive(data, attendee, external, throttled));
        }
      };

  private Channel() {}

  /** A huddle's audio started, with its Chime session ready. */
  public static void attach(Object meetingSession) {
    try {
      Object av = field(meetingSession, "chimeAudioVideo");
      if (av == null) {
        HuddleFM.log("The huddle has no Chime session");
        return;
      }
      Method add = method(av, "addRealtimeDataMessageObserver", 2);
      Method sendMethod = method(av, "realtimeSendDataMessage", 2);
      add.invoke(av, Client.TOPIC, observer);
      final WeakReference<Object> ref = new WeakReference<>(meetingSession);
      HuddleFM.main.post(
          () -> {
            session = ref;
            facade = av;
            send = sendMethod;
            HuddleFM.client.connect(Channel::send, () -> self(ref.get()));
            HuddleFM.log("Listening in the huddle");
          });
    } catch (Throwable t) {
      HuddleFM.log("Couldn't reach the huddle's data channel: " + t);
    }
  }

  /** The channel of the huddle the user is in, from Slack's huddle state, or null. */
  static volatile String channelId;

  /** Slack's huddle state became active, for a channel's huddle. */
  public static void huddle(Object active) {
    try {
      Object id = field(active, "channelId");
      if (id instanceof String) channelId = (String) id;
      Object team = field(active, "teamId");
      if (team instanceof String) Invite.teamId = (String) team;
    } catch (Throwable t) {
      HuddleFM.log("Couldn't read the huddle's channel: " + t);
    }
  }

  /** The huddle's being left. */
  public static void detach(Object meetingSession) {
    HuddleFM.main.post(
        () -> {
          if (session.get() != meetingSession) return;
          session = new WeakReference<>(null);
          facade = null;
          send = null;
          HuddleFM.client.disconnect();
        });
  }

  private static void send(byte[] data) throws Exception {
    Object av = facade;
    Method m = send;
    if (av == null || m == null) throw new IllegalStateException("Not in a huddle");
    m.invoke(av, data, Client.TOPIC);
  }

  /** This user, from the Chime external user id Slack joined with. */
  private static String self(Object meetingSession) {
    try {
      return Client.slackUserId((String) field(meetingSession, "chimeHostExternalUserId"));
    } catch (Throwable t) {
      return null;
    }
  }

  private static Object field(Object object, String name) throws ReflectiveOperationException {
    if (object == null) return null;
    Field f = object.getClass().getField(name);
    return f.get(object);
  }

  private static Method method(Object object, String name, int arguments) throws NoSuchMethodException {
    for (Method m : object.getClass().getMethods())
      if (m.getName().equals(name) && m.getParameterTypes().length == arguments) return m;
    throw new NoSuchMethodException(name);
  }
}
