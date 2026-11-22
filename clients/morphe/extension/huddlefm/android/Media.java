package huddlefm.android;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.SystemClock;
import android.widget.Toast;
import org.json.JSONObject;

/**
 * HuddleFM's song in Android's media controls, while HuddleFM is in the huddle: a media session
 * with the song, its artwork and position, and play/pause, previous, next and seeking, which run
 * as the card's buttons do. Slack's huddle runs as a call, so the media controls are HuddleFM's.
 */
final class Media {
  private static final String CHANNEL = "huddlefm_media";
  private static final int NOTIFICATION = 0x48464d; // "HFM"
  private static final String PREF = "mediaControls";
  private static final String ACTION = "huddlefm.android.MEDIA";

  private static Application app;
  private static MediaSession session;
  private static String shownSong;
  private static String artworkUrl;
  private static Bitmap artwork;
  private static String notified;

  private Media() {}

  static void init(Application application) {
    app = application;
    try {
      NotificationChannel channel =
          new NotificationChannel(CHANNEL, "HuddleFM", NotificationManager.IMPORTANCE_LOW);
      channel.setDescription("What HuddleFM is playing in your huddle");
      channel.setShowBadge(false);
      manager().createNotificationChannel(channel);
      app.registerReceiver(
          new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
              run(intent.getStringExtra("command"));
            }
          },
          new IntentFilter(ACTION),
          Context.RECEIVER_NOT_EXPORTED);
      HuddleFM.client.listen(Media::update);
    } catch (Throwable t) {
      HuddleFM.log("Couldn't set up media controls: " + t);
    }
  }

  private static SharedPreferences prefs() {
    return app.getSharedPreferences("huddlefm", Context.MODE_PRIVATE);
  }

  /** Whether the user wants HuddleFM in the media controls; on unless they turned it off. */
  static boolean enabled() {
    return app != null && prefs().getBoolean(PREF, true);
  }

  static void setEnabled(boolean on) {
    prefs().edit().putBoolean(PREF, on).apply();
    update();
  }

  private static NotificationManager manager() {
    return (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
  }

  /** Brings the media controls in line with the session, or takes them away. */
  static void update() {
    if (app == null) return;
    try {
      Client client = HuddleFM.client;
      JSONObject song = client.nowPlaying();
      if (!enabled() || client.presence != Client.Presence.CONNECTED || song == null) {
        release();
        return;
      }
      if (session == null) {
        session = new MediaSession(app, "HuddleFM");
        session.setCallback(
            new MediaSession.Callback() {
              @Override
              public void onPlay() {
                run("toggle");
              }

              @Override
              public void onPause() {
                run("toggle");
              }

              @Override
              public void onSkipToNext() {
                run("skip");
              }

              @Override
              public void onSkipToPrevious() {
                run("previous");
              }

              @Override
              public void onSeekTo(long position) {
                if (allowed("skip")) HuddleFM.client.seek(position / 1000.0, Media::say);
              }
            },
            HuddleFM.main);
        session.setActive(true);
      }

      String id = song.optString("id");
      String url = song.optString("artwork", "");
      if (!id.equals(shownSong) || !url.equals(artworkUrl)) {
        shownSong = id;
        if (!url.equals(artworkUrl)) {
          artworkUrl = url;
          artwork = null;
          Images.get(
              url,
              512,
              bitmap -> {
                if (!url.equals(artworkUrl)) return;
                artwork = bitmap;
                metadata(HuddleFM.client.nowPlaying());
                notify(true);
              });
        }
      }
      metadata(song);

      boolean playing = "playing".equals(client.session().optString("state"));
      long actions = 0;
      if (client.can("pause")) actions |= PlaybackState.ACTION_PLAY_PAUSE | (playing ? PlaybackState.ACTION_PAUSE : PlaybackState.ACTION_PLAY);
      if (client.can("skip")) {
        actions |= PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        if (!song.optBoolean("live")) actions |= PlaybackState.ACTION_SEEK_TO;
      }
      session.setPlaybackState(
          new PlaybackState.Builder()
              .setActions(actions)
              // the position now, and the speed it moves at, so the system keeps it moving
              .setState(
                  playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                  (long) (client.position() * 1000),
                  playing ? 1f : 0f,
                  SystemClock.elapsedRealtime())
              .build());
      notify(false);
    } catch (Throwable t) {
      HuddleFM.log("Couldn't update media controls: " + t);
    }
  }

  private static void metadata(JSONObject song) {
    if (song == null || session == null) return;
    MediaMetadata.Builder m =
        new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, song.optString("title"))
            .putString(MediaMetadata.METADATA_KEY_ARTIST, song.optString("artist", ""))
            .putString(MediaMetadata.METADATA_KEY_ALBUM, song.optString("album", ""));
    double duration = song.optDouble("duration", 0);
    if (duration > 0 && !song.optBoolean("live")) m.putLong(MediaMetadata.METADATA_KEY_DURATION, (long) (duration * 1000));
    if (artwork != null) m.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
    session.setMetadata(m.build());
  }

  /** Posts the media notification the controls are drawn from, when what it shows changed. */
  private static void notify(boolean force) {
    if (session == null) return;
    Client client = HuddleFM.client;
    JSONObject song = client.nowPlaying();
    if (song == null) return;
    boolean playing = "playing".equals(client.session().optString("state"));
    String key = song.optString("id") + playing + client.can("pause") + client.can("skip") + (artwork != null);
    if (!force && key.equals(notified)) return;
    notified = key;

    Notification.Builder b =
        new Notification.Builder(app, CHANNEL)
            .setSmallIcon(Icon.createWithResource(app, Ui.drawable("music")))
            .setContentTitle(song.optString("title"))
            .setContentText(song.optString("artist", ""))
            .setSubText("HuddleFM")
            .setOngoing(playing)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_TRANSPORT);
    if (artwork != null) b.setLargeIcon(artwork);
    PendingIntent open = open();
    if (open != null) b.setContentIntent(open);
    int shown = 0;
    if (client.can("skip")) {
      b.addAction(action("previous_filled", "Previous", "previous"));
      shown++;
    }
    if (client.can("pause")) {
      b.addAction(action(playing ? "pause_filled" : "play_filled", playing ? "Pause" : "Play", "toggle"));
      shown++;
    }
    if (client.can("skip")) {
      b.addAction(action("next_filled", "Next", "skip"));
      shown++;
    }
    Notification.MediaStyle style = new Notification.MediaStyle().setMediaSession(session.getSessionToken());
    if (shown == 3) style.setShowActionsInCompactView(0, 1, 2);
    else if (shown > 0) style.setShowActionsInCompactView(0);
    b.setStyle(style);
    try {
      manager().notify(NOTIFICATION, b.build());
    } catch (SecurityException e) {
      // notifications are off for Slack: the session still reaches headphones and the like
    }
  }

  private static Notification.Action action(String icon, String label, String command) {
    Intent intent = new Intent(ACTION).setPackage(app.getPackageName()).putExtra("command", command);
    PendingIntent pending =
        PendingIntent.getBroadcast(
            app, command.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    return new Notification.Action.Builder(Icon.createWithResource(app, Ui.drawable(icon)), label, pending).build();
  }

  /** Back to the huddle, from the media controls. */
  private static PendingIntent open() {
    Intent intent;
    try {
      intent = new Intent(app, Class.forName("slack.features.huddles.activity.activehuddle.ActiveHuddleActivity"));
      if (Invite.teamId != null) intent.putExtra("extra_team_id", Invite.teamId);
    } catch (ClassNotFoundException e) {
      intent = app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
      if (intent == null) return null;
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return PendingIntent.getActivity(app, 1, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
  }

  private static void run(String command) {
    if (command == null) return;
    String capability = "toggle".equals(command) ? "pause" : "skip";
    if (allowed(capability)) HuddleFM.client.command(Client.object("type", command), Media::say);
  }

  private static boolean allowed(String capability) {
    if (HuddleFM.client.can(capability)) return true;
    Toast.makeText(app, Panel.why(capability), Toast.LENGTH_SHORT).show();
    return false;
  }

  private static void say(JSONObject result) {
    if (result.optBoolean("ok")) return;
    String message = result.optString("message", "");
    Toast.makeText(app, message.isEmpty() ? "That didn't work." : message, Toast.LENGTH_SHORT).show();
  }

  private static void release() {
    if (session != null) {
      session.setActive(false);
      session.release();
      session = null;
    }
    shownSong = null;
    artworkUrl = null;
    artwork = null;
    notified = null;
    manager().cancel(NOTIFICATION);
  }
}
