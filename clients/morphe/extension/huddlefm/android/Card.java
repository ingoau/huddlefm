package huddlefm.android;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;

/**
 * The now playing card above the huddle's bottom bar, while HuddleFM is in the huddle: the song,
 * play/pause and skip. A tap anywhere else opens HuddleFM's controls.
 */
final class Card extends FrameLayout {
  private final Client client = HuddleFM.client;
  private final LinearLayout box;
  private final ImageView artwork;
  private final TextView title;
  private final TextView subtitle;
  private final ImageView playPause;
  private final ImageView next;
  private final Progress progress;
  private final Runnable listener = this::refresh;
  private final Runnable tick = this::tick;
  private String artworkUrl;

  /** The song's progress, a line along the card's foot. */
  private static final class Progress extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    float fraction;

    Progress(Context context) {
      super(context);
      paint.setColor(Ui.TEXT);
    }

    @Override
    protected void onDraw(Canvas canvas) {
      canvas.drawRect(0, 0, getWidth() * Math.max(0, Math.min(1, fraction)), getHeight(), paint);
    }
  }

  Card(Context c) {
    super(c);
    setClipChildren(false);
    box = Ui.row(c);
    int r = dp(12);
    GradientDrawable bg = Ui.rounded(0xF21A1D21, r);
    box.setBackground(Ui.pressable(bg, r));
    box.setPadding(dp(8), dp(8), dp(4), dp(8));
    box.setClickable(true);
    box.setContentDescription("HuddleFM, open its controls");
    box.setOnClickListener(v -> Panel.open());
    Ui.clip(box, r);

    artwork = new ImageView(c);
    artwork.setScaleType(ImageView.ScaleType.CENTER_CROP);
    Ui.clip(artwork, dp(8));
    box.addView(artwork, new LinearLayout.LayoutParams(dp(40), dp(40)));

    LinearLayout words = Ui.column(c);
    words.setPadding(dp(12), 0, dp(4), 0);
    title = Ui.line(c, "", 15, Ui.TEXT, true);
    words.addView(title);
    subtitle = Ui.line(c, "", 13, Ui.SECONDARY, false);
    subtitle.setPadding(0, dp(3), 0, 0);
    words.addView(subtitle);
    box.addView(words, Ui.weight(1));

    playPause = Ui.iconButton(c, "pause_filled", Ui.TEXT, dp(44), dp(24), "Pause");
    playPause.setOnClickListener(
        v -> {
          if (allowed("pause")) client.command(Client.object("type", "toggle"), this::say);
        });
    box.addView(playPause);
    next = Ui.iconButton(c, "next_filled", Ui.TEXT, dp(44), dp(24), "Next");
    next.setOnClickListener(
        v -> {
          if (allowed("skip")) client.command(Client.object("type", "skip"), this::say);
        });
    box.addView(next);

    FrameLayout holder = new FrameLayout(c);
    holder.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    progress = new Progress(c);
    holder.addView(progress, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2), Gravity.BOTTOM));
    Ui.clip(holder, r);
    LayoutParams lp = new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    // inset from the screen's sides as Slack's own banners are
    lp.setMargins(dp(16), dp(8), dp(16), dp(2));
    addView(holder, lp);
    refresh();
  }

  private int dp(float value) {
    return Ui.dp(getContext(), value);
  }

  /** Takes the bar's whole width, whatever the column offers its children. */
  @Override
  protected void onMeasure(int width, int height) {
    int size = MeasureSpec.getSize(width);
    if (MeasureSpec.getMode(width) != MeasureSpec.UNSPECIFIED)
      width = MeasureSpec.makeMeasureSpec(size, MeasureSpec.EXACTLY);
    super.onMeasure(width, height);
  }

  @Override
  protected void onAttachedToWindow() {
    super.onAttachedToWindow();
    client.listen(listener);
    refresh();
  }

  @Override
  protected void onDetachedFromWindow() {
    client.unlisten(listener);
    removeCallbacks(tick);
    super.onDetachedFromWindow();
  }

  private boolean allowed(String capability) {
    if (client.can(capability)) return true;
    Toast.makeText(getContext(), Panel.why(capability), Toast.LENGTH_SHORT).show();
    return false;
  }

  private void say(JSONObject result) {
    if (result.optBoolean("ok")) return;
    String message = result.optString("message", "");
    Toast.makeText(getContext(), message.isEmpty() ? "That didn't work." : message, Toast.LENGTH_SHORT).show();
  }

  private void refresh() {
    boolean here = client.presence == Client.Presence.CONNECTED && client.session() != null;
    // gone, the card takes no room, and the bar is as Slack draws it
    getChildAt(0).setVisibility(here ? VISIBLE : GONE);
    if (!here) {
      removeCallbacks(tick);
      return;
    }
    JSONObject song = client.nowPlaying();
    JSONObject session = client.session();
    if (song == null) {
      title.setText("Nothing playing");
      subtitle.setText(client.can("add") ? "Tap to add a song" : "HuddleFM is in the huddle");
      playPause.setVisibility(GONE);
      next.setVisibility(GONE);
      progress.setVisibility(GONE);
      setArtwork("");
      removeCallbacks(tick);
      return;
    }
    title.setText(song.optString("title"));
    String artist = song.optString("artist", "");
    int queued = client.state.optInt("queueLength", 0);
    String upNext = queued > 0 ? queued + " up next" : "";
    subtitle.setText(TextUtils.join(" · ", artist.isEmpty() ? new String[] {upNext.isEmpty() ? "HuddleFM" : upNext} : upNext.isEmpty() ? new String[] {artist} : new String[] {artist, upNext}));
    boolean paused = !"playing".equals(session.optString("state"));
    playPause.setImageDrawable(Ui.icon(getContext(), paused ? "play_filled" : "pause_filled", Ui.TEXT));
    playPause.setContentDescription(paused ? "Play" : "Pause");
    playPause.setVisibility(VISIBLE);
    next.setVisibility(VISIBLE);
    playPause.setAlpha(client.can("pause") ? 1f : 0.4f);
    next.setAlpha(client.can("skip") ? 1f : 0.4f);
    progress.setVisibility(song.optBoolean("live") ? GONE : VISIBLE);
    setArtwork(song.optString("artwork", ""));
    tick();
  }

  private void setArtwork(String url) {
    if (url.equals(artworkUrl)) return;
    artworkUrl = url;
    Images.load(
        artwork,
        url,
        dp(40),
        () -> {
          GradientDrawable bg = Ui.rounded(Ui.RAISED, dp(8));
          android.graphics.drawable.Drawable note = Ui.icon(getContext(), "music", Ui.SECONDARY);
          android.graphics.drawable.LayerDrawable layers =
              new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[] {bg, note});
          layers.setLayerInset(1, dp(10), dp(10), dp(10), dp(10));
          artwork.setImageDrawable(layers);
        });
  }

  private void tick() {
    removeCallbacks(tick);
    JSONObject song = client.nowPlaying();
    if (song == null || !isAttachedToWindow()) return;
    double duration = song.optDouble("duration", 0);
    progress.fraction = duration > 0 ? (float) (client.position() / duration) : 0;
    progress.invalidate();
    postDelayed(tick, 1000);
  }
}
