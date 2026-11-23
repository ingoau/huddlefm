package huddlefm.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * HuddleFM's controls, opened from its bottom bar button: a sheet over the huddle with what the
 * desktop plugins' popover has, drawn with Android's views in the huddle's dark look.
 */
final class Panel {
  private static Panel current;

  static void open() {
    Activity activity = HuddleFM.activity();
    if (activity == null || activity.isFinishing()) return;
    if (current != null && current.dialog.isShowing()) {
      if (current.activity == activity) return;
      current.dialog.dismiss();
    }
    try {
      current = new Panel(activity);
      current.dialog.show();
    } catch (Throwable t) {
      HuddleFM.log("Couldn't open the panel: " + t);
    }
  }

  /** Closes the sheet over [activity], as it's going out of sight. */
  static void hide(Activity activity) {
    if (current != null && current.activity == activity) {
      current.dialog.dismiss();
      current = null;
    }
  }

  private enum Page {
    MAIN,
    SETTINGS,
    SAVES,
    SUGGESTIONS
  }

  /** What each permission lets someone do, to say why a control is off. */
  private static final Map<String, String> ABILITIES = new LinkedHashMap<>();

  static {
    ABILITIES.put("add", "add songs");
    ABILITIES.put("add-bulk", "add albums and playlists");
    ABILITIES.put("skip", "skip songs or seek");
    ABILITIES.put("pause", "pause or resume");
    ABILITIES.put("volume", "change the volume");
    ABILITIES.put("manage-queue", "reorder the queue");
    ABILITIES.put("clear", "clear the queue");
    ABILITIES.put("end-session", "end the session");
    ABILITIES.put("configure-settings", "change the session's settings");
  }

  private final Activity activity;
  private final Context c;
  private final Client client = HuddleFM.client;
  private final Dialog dialog;
  private final Runnable listener = this::refresh;
  private final Runnable tick = this::tick;

  private Page page = Page.MAIN;
  private TextView status;
  private ImageView settingsButton;
  private ImageView backButton;
  private ImageView logo;
  private TextView title;
  private ScrollView scroll;
  private LinearLayout body;

  // the main page's pieces, updated in place
  private LinearLayout away;
  private TextView awayTitle;
  private TextView awayText;
  private TextView invite;
  private LinearLayout now;
  private LinearLayout playing;
  private LinearLayout idle;
  private TextView idleText;
  private TextView playSomething;
  private ImageView artwork;
  private TextView songTitle;
  private TextView songArtist;
  private TextView liveBadge;
  private SeekBar seek;
  private TextView elapsed;
  private TextView remaining;
  private ImageView previous;
  private ImageView playPause;
  private ImageView next;
  private SeekBar volume;
  private TextView volumeText;
  private LinearLayout add;
  private EditText search;
  private LinearLayout results;
  private LinearLayout tabs;
  private TextView queueTab;
  private TextView lyricsTab;
  private ImageView shuffle;
  private ImageView clear;
  private LinearLayout list;
  /** Lyrics scroll on their own, so following the song doesn't move the controls away. */
  private ScrollView lyricsBox;
  private LinearLayout lyricsList;
  private LinearLayout host;

  private boolean seeking;
  /** A queue row's menu is open, so the rows stay as they are under it. */
  private boolean menuOpen;
  private boolean changingVolume;
  private boolean showLyrics;
  private String shownQueue;
  private String artworkUrl;
  private String lyricsFor;
  /** The settings and permissions the Settings page was drawn from. */
  private String shownSettings;
  private ImageView sparkles;
  private List<JSONObject> lyrics = new ArrayList<>();
  private boolean lyricsSynced;
  private final List<TextView> lyricLines = new ArrayList<>();
  private int litLine = -2;
  private final Runnable searchLater = this::search;
  private int searchCount;

  private Panel(Activity activity) {
    this.activity = activity;
    this.c = activity;
    dialog =
        new Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar) {
          @Override
          public void onBackPressed() {
            if (page != Page.MAIN) Panel.this.show(Page.MAIN);
            else super.onBackPressed();
          }
        };
    dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
    dialog.setContentView(build());
    dialog.setCanceledOnTouchOutside(true);
    Window window = dialog.getWindow();
    if (window != null) {
      window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
      window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
      window.setGravity(Gravity.BOTTOM);
      window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
      window.setDimAmount(0.45f);
      window.setSoftInputMode(
          WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
              | WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN);
      window.setWindowAnimations(android.R.style.Animation_InputMethod);
      window.setNavigationBarColor(Ui.BACKGROUND);
    }
    dialog.setOnShowListener(
        d -> {
          client.listen(listener);
          HuddleFM.main.post(tick);
        });
    dialog.setOnDismissListener(
        d -> {
          client.unlisten(listener);
          HuddleFM.main.removeCallbacks(tick);
          HuddleFM.main.removeCallbacks(searchLater);
          if (current == this) current = null;
        });
    show(Page.MAIN);
  }

  // --- the sheet

  private int dp(float value) {
    return Ui.dp(c, value);
  }

  private View build() {
    LinearLayout sheet =
        new LinearLayout(c) {
          @Override
          protected void onMeasure(int width, int height) {
            int max = (int) (getResources().getDisplayMetrics().heightPixels * 0.88f);
            super.onMeasure(width, View.MeasureSpec.makeMeasureSpec(max, View.MeasureSpec.AT_MOST));
          }
        };
    sheet.setOrientation(LinearLayout.VERTICAL);
    float r = dp(20);
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(Ui.BACKGROUND);
    bg.setCornerRadii(new float[] {r, r, r, r, 0, 0, 0, 0});
    sheet.setBackground(bg);
    sheet.setClickable(true);

    View grabber = new View(c);
    grabber.setBackground(Ui.rounded(Ui.LINE, dp(2)));
    LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(dp(36), dp(4));
    gp.gravity = Gravity.CENTER_HORIZONTAL;
    gp.setMargins(0, dp(8), 0, dp(4));
    sheet.addView(grabber, gp);

    LinearLayout header = Ui.row(c);
    header.setPadding(dp(12), dp(6), dp(8), dp(10));
    backButton = Ui.iconButton(c, "arrow_left", Ui.TEXT, dp(40), dp(22), "Back");
    backButton.setOnClickListener(v -> show(Page.MAIN));
    header.addView(backButton);
    logo = new ImageView(c);
    BitmapDrawable logoDrawable = new BitmapDrawable(c.getResources(), Logo.bitmap());
    logoDrawable.setFilterBitmap(false);
    logo.setImageDrawable(logoDrawable);
    Ui.clip(logo, dp(8));
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(36), dp(36));
    lp.setMargins(dp(6), 0, dp(10), 0);
    header.addView(logo, lp);
    LinearLayout titles = Ui.column(c);
    title = Ui.line(c, "HuddleFM", 18, Ui.TEXT, true);
    title.setTypeface(Ui.black(c));
    titles.addView(title);
    status = Ui.line(c, "", 13, Ui.SECONDARY, false);
    status.setPadding(0, dp(3), 0, 0);
    titles.addView(status);
    header.addView(titles, Ui.weight(1));
    settingsButton = Ui.iconButton(c, "settings", Ui.TEXT, dp(44), dp(22), "Settings");
    settingsButton.setOnClickListener(v -> show(Page.SETTINGS));
    header.addView(settingsButton);
    ImageView close = Ui.iconButton(c, "close", Ui.TEXT, dp(44), dp(22), "Close");
    close.setOnClickListener(v -> dialog.dismiss());
    header.addView(close);
    sheet.addView(header, Ui.wide());
    draggable(sheet, grabber, header);
    sheet.addView(Ui.divider(c));

    scroll = new ScrollView(c);
    scroll.setFillViewport(true);
    scroll.setVerticalScrollBarEnabled(false);
    body = Ui.column(c);
    body.setPadding(dp(16), dp(12), dp(16), dp(24));
    scroll.addView(body, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    sheet.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
    sheet.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));
    return sheet;
  }

  /** Dragging the sheet down by its top closes it, as Slack's own sheets do. */
  private void draggable(View sheet, View... handles) {
    final float[] start = new float[1];
    final long[] at = new long[1];
    View.OnTouchListener drag =
        (v, e) -> {
          switch (e.getActionMasked()) {
            case android.view.MotionEvent.ACTION_DOWN:
              start[0] = e.getRawY();
              at[0] = e.getEventTime();
              return true;
            case android.view.MotionEvent.ACTION_MOVE:
              sheet.setTranslationY(Math.max(0, e.getRawY() - start[0]));
              return true;
            case android.view.MotionEvent.ACTION_UP:
            case android.view.MotionEvent.ACTION_CANCEL:
              float moved = e.getRawY() - start[0];
              float speed = moved / Math.max(1, e.getEventTime() - at[0]);
              if (moved > dp(120) || (moved > dp(24) && speed > 1f))
                sheet.animate().translationY(sheet.getHeight()).setDuration(160).withEndAction(dialog::dismiss).start();
              else {
                sheet.animate().translationY(0).setDuration(160).start();
                if (Math.abs(moved) < dp(8)) v.performClick();
              }
              return true;
            default:
              return false;
          }
        };
    for (View handle : handles) handle.setOnTouchListener(drag);
  }

  private void show(Page next) {
    page = next;
    // a search still waiting to go out was typed into the page being replaced
    HuddleFM.main.removeCallbacks(searchLater);
    body.removeAllViews();
    hideKeyboard();
    backButton.setVisibility(next == Page.MAIN ? View.GONE : View.VISIBLE);
    logo.setVisibility(next == Page.MAIN ? View.VISIBLE : View.GONE);
    settingsButton.setVisibility(next == Page.MAIN ? View.VISIBLE : View.GONE);
    switch (next) {
      case MAIN:
        title.setText("HuddleFM");
        buildMain();
        break;
      case SETTINGS:
        title.setText("Settings");
        buildSettings();
        break;
      case SAVES:
        title.setText("Load a saved session");
        buildSaves();
        break;
      case SUGGESTIONS:
        title.setText("Add a song");
        buildSuggestions();
        break;
    }
    scroll.scrollTo(0, 0);
    refresh();
  }

  // --- talking to the bot

  private void run(JSONObject command) {
    client.command(command, this::say);
  }

  /** Says what the bot answered, as the player's ephemeral notices would. */
  private void say(JSONObject result) {
    if (!dialog.isShowing()) return;
    String message = result.optString("message", "");
    if (!result.optBoolean("ok")) {
      if (message.isEmpty()) message = "That didn't work.";
      toast(message);
    } else if (!message.isEmpty()) toast(message);
  }

  private void toast(String text) {
    Toast.makeText(activity, text, Toast.LENGTH_SHORT).show();
  }

  /** Whether the user may, saying why not when they may not. */
  private boolean allowed(String capability) {
    if (client.can(capability)) return true;
    toast(why(capability));
    return false;
  }

  /** Why the user may not do something, saying who to ask. */
  static String why(String capability) {
    Client client = HuddleFM.client;
    String ability = ABILITIES.containsKey(capability) ? ABILITIES.get(capability) : "do that";
    String self = client.selfUserId();
    JSONObject session = client.session();
    // the bot only lets those it sees in the huddle use it
    if (self != null && client.state != null && !Client.strings(client.state.optJSONArray("participants")).contains(self))
      return "HuddleFM doesn't see you in the huddle yet.";
    String hostId = session == null ? null : session.optString("hostId", null);
    if (hostId != null && !"null".equals(hostId) && !hostId.equals(self))
      return "Ask the host to let you " + ability + ".";
    return "You can't " + ability + " in this session.";
  }

  private static String hostId(JSONObject session) {
    if (session == null || session.isNull("hostId")) return null;
    String id = session.optString("hostId", "");
    return id.isEmpty() ? null : id;
  }

  // --- the main page

  private void buildMain() {
    away = Ui.column(c);
    away.setGravity(Gravity.CENTER_HORIZONTAL);
    away.setPadding(dp(8), dp(28), dp(8), dp(28));
    ImageView note = new ImageView(c);
    note.setImageDrawable(Ui.icon(c, "music", Ui.SECONDARY));
    away.addView(note, new LinearLayout.LayoutParams(dp(40), dp(40)));
    awayTitle = Ui.text(c, "", 17, Ui.TEXT, true);
    awayTitle.setGravity(Gravity.CENTER);
    awayTitle.setPadding(0, dp(14), 0, dp(6));
    away.addView(awayTitle);
    awayText = Ui.text(c, "", 14, Ui.SECONDARY, false);
    awayText.setGravity(Gravity.CENTER);
    away.addView(awayText);
    invite = Ui.button(c, "Start HuddleFM", true);
    invite.setOnClickListener(v -> invite());
    away.addView(invite, Ui.margins(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT), 0, dp(20), 0, 0));
    body.addView(away, Ui.wide());

    now = Ui.column(c);
    buildNowPlaying();
    body.addView(now, Ui.wide());

    add = Ui.column(c);
    buildAdd();
    body.addView(add, Ui.margins(Ui.wide(), 0, dp(20), 0, 0));

    tabs = Ui.row(c);
    queueTab = tab("Up next", () -> {
      showLyrics = false;
      shownQueue = null;
      refresh();
    });
    tabs.addView(queueTab);
    lyricsTab = tab("Lyrics", () -> {
      showLyrics = true;
      shownQueue = null;
      refresh();
    });
    tabs.addView(lyricsTab, Ui.margins(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT), dp(8), 0, 0, 0));
    View gap = new View(c);
    tabs.addView(gap, Ui.weight(1));
    shuffle = Ui.iconButton(c, "shuffle", Ui.SECONDARY, dp(36), dp(18), "Shuffle");
    shuffle.setOnClickListener(v -> {
      if (allowed("manage-queue")) run(Client.object("type", "shuffle"));
    });
    tabs.addView(shuffle);
    clear = Ui.iconButton(c, "trash", Ui.SECONDARY, dp(36), dp(18), "Clear queue");
    clear.setOnClickListener(v -> confirmClear());
    tabs.addView(clear);
    body.addView(tabs, Ui.margins(Ui.wide(), 0, dp(22), 0, dp(6)));

    list = Ui.column(c);
    body.addView(list, Ui.wide());

    lyricsBox = new ScrollView(c);
    lyricsBox.setNestedScrollingEnabled(true);
    lyricsBox.setVerticalScrollBarEnabled(false);
    lyricsBox.setFadingEdgeLength(dp(40));
    lyricsBox.setVerticalFadingEdgeEnabled(true);
    lyricsList = Ui.column(c);
    lyricsList.setPadding(0, dp(4), 0, dp(120));
    lyricsBox.addView(lyricsList, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    body.addView(lyricsBox, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(340)));

    host = Ui.row(c);
    host.setPadding(dp(14), dp(12), dp(10), dp(12));
    host.setBackground(Ui.rounded(Ui.SURFACE, dp(10)));
    TextView nobody = Ui.text(c, "Nobody is host right now.", 14, Ui.SECONDARY, false);
    host.addView(nobody, Ui.weight(1));
    TextView takeOver = Ui.button(c, "Take over", false);
    takeOver.setTextSize(14);
    takeOver.setPadding(dp(14), dp(8), dp(14), dp(8));
    takeOver.setOnClickListener(v -> run(Client.object("type", "claim_host")));
    host.addView(takeOver);
    body.addView(host, Ui.margins(Ui.wide(), 0, dp(18), 0, 0));

    shownQueue = null;
    artworkUrl = null;
    // a new page: nothing of the last one's lyrics or searches lands on it
    lyricsFor = null;
    lyricLines.clear();
    searchCount++;
  }

  private TextView tab(String label, Runnable onClick) {
    TextView t = Ui.text(c, label, 14, Ui.SECONDARY, true);
    t.setPadding(dp(14), dp(8), dp(14), dp(8));
    t.setOnClickListener(v -> onClick.run());
    return t;
  }

  private void selectTab(TextView t, boolean selected) {
    t.setTextColor(selected ? Ui.BACKGROUND : Ui.SECONDARY);
    t.setBackground(Ui.pressable(Ui.rounded(selected ? Ui.TEXT : Ui.SURFACE, dp(16)), dp(16)));
  }

  private void buildNowPlaying() {
    playing = Ui.column(c);
    playing.setPadding(dp(14), dp(14), dp(14), dp(10));
    playing.setBackground(Ui.rounded(Ui.SURFACE, dp(14)));

    LinearLayout top = Ui.row(c);
    artwork = new ImageView(c);
    artwork.setScaleType(ImageView.ScaleType.CENTER_CROP);
    Ui.clip(artwork, dp(10));
    top.addView(artwork, new LinearLayout.LayoutParams(dp(72), dp(72)));
    LinearLayout words = Ui.column(c);
    words.setPadding(dp(14), 0, 0, 0);
    songTitle = Ui.text(c, "", 17, Ui.TEXT, true);
    songTitle.setMaxLines(2);
    songTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
    words.addView(songTitle);
    songArtist = Ui.line(c, "", 14, Ui.SECONDARY, false);
    songArtist.setPadding(0, dp(5), 0, 0);
    words.addView(songArtist);
    liveBadge = Ui.text(c, "LIVE", 11, Color.WHITE, true);
    liveBadge.setPadding(dp(6), dp(2), dp(6), dp(2));
    liveBadge.setBackground(Ui.rounded(Ui.DANGER, dp(4)));
    words.addView(liveBadge, Ui.margins(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT), 0, dp(6), 0, 0));
    top.addView(words, Ui.weight(1));
    playing.addView(top, Ui.wide());

    seek = new SeekBar(c);
    seek.setMax(1000);
    tint(seek, Ui.TEXT);
    seek.setPadding(dp(4), dp(14), dp(4), dp(4));
    seek.setOnSeekBarChangeListener(
        new SeekBar.OnSeekBarChangeListener() {
          @Override
          public void onProgressChanged(SeekBar bar, int progress, boolean user) {
            if (!user) return;
            double duration = duration();
            elapsed.setText(Ui.time(duration * progress / 1000.0));
          }

          @Override
          public void onStartTrackingTouch(SeekBar bar) {
            seeking = true;
          }

          @Override
          public void onStopTrackingTouch(SeekBar bar) {
            seeking = false;
            if (!allowed("skip")) {
              tick();
              return;
            }
            client.seek(duration() * bar.getProgress() / 1000.0, Panel.this::say);
          }
        });
    playing.addView(seek, Ui.margins(Ui.wide(), -dp(4), dp(6), -dp(4), 0));
    LinearLayout times = Ui.row(c);
    elapsed = Ui.text(c, "0:00", 12, Ui.SECONDARY, false);
    remaining = Ui.text(c, "", 12, Ui.SECONDARY, false);
    times.addView(elapsed, Ui.weight(1));
    times.addView(remaining);
    playing.addView(times, Ui.wide());

    LinearLayout controls = Ui.row(c);
    controls.setGravity(Gravity.CENTER);
    previous = Ui.iconButton(c, "previous_filled", Ui.TEXT, dp(52), dp(26), "Previous");
    previous.setOnClickListener(v -> {
      if (allowed("skip")) run(Client.object("type", "previous"));
    });
    controls.addView(previous);
    playPause = Ui.iconButton(c, "play_filled", Ui.BACKGROUND, dp(60), dp(28), "Play");
    playPause.setBackground(Ui.pressable(Ui.rounded(Ui.TEXT, dp(30)), dp(30)));
    playPause.setOnClickListener(v -> {
      if (allowed("pause")) run(Client.object("type", "toggle"));
    });
    controls.addView(playPause, Ui.margins(new LinearLayout.LayoutParams(dp(60), dp(60)), dp(28), 0, dp(28), 0));
    next = Ui.iconButton(c, "next_filled", Ui.TEXT, dp(52), dp(26), "Next");
    next.setOnClickListener(v -> {
      if (allowed("skip")) run(Client.object("type", "skip"));
    });
    controls.addView(next);
    playing.addView(controls, Ui.margins(Ui.wide(), 0, dp(4), 0, dp(8)));

    LinearLayout volumeRow = Ui.row(c);
    ImageView sound = new ImageView(c);
    sound.setImageDrawable(Ui.icon(c, "sound", Ui.SECONDARY));
    volumeRow.addView(sound, new LinearLayout.LayoutParams(dp(20), dp(20)));
    volume = new SeekBar(c);
    volume.setMax(100);
    tint(volume, Ui.SECONDARY);
    volume.setOnSeekBarChangeListener(
        new SeekBar.OnSeekBarChangeListener() {
          @Override
          public void onProgressChanged(SeekBar bar, int progress, boolean user) {
            if (user) volumeText.setText(progress + "%");
          }

          @Override
          public void onStartTrackingTouch(SeekBar bar) {
            changingVolume = true;
          }

          @Override
          public void onStopTrackingTouch(SeekBar bar) {
            if (!allowed("volume")) {
              changingVolume = false;
              refresh();
              return;
            }
            client.command(
                Client.object("type", "volume", "percent", bar.getProgress()),
                result -> {
                  changingVolume = false;
                  say(result);
                });
          }
        });
    volumeRow.addView(volume, Ui.weight(1));
    volumeText = Ui.text(c, "", 12, Ui.SECONDARY, false);
    volumeText.setMinWidth(dp(36));
    volumeText.setGravity(Gravity.END);
    volumeRow.addView(volumeText);
    playing.addView(volumeRow, Ui.wide());
    now.addView(playing, Ui.wide());

    idle = Ui.column(c);
    idle.setGravity(Gravity.CENTER_HORIZONTAL);
    idle.setPadding(dp(16), dp(22), dp(16), dp(18));
    idle.setBackground(Ui.rounded(Ui.SURFACE, dp(14)));
    TextView nothing = Ui.text(c, "Nothing playing", 17, Ui.TEXT, true);
    idle.addView(nothing);
    idleText = Ui.text(c, "", 14, Ui.SECONDARY, false);
    idleText.setGravity(Gravity.CENTER);
    idleText.setPadding(0, dp(6), 0, dp(14));
    idle.addView(idleText);
    LinearLayout idleButtons = Ui.row(c);
    idleButtons.setGravity(Gravity.CENTER);
    playSomething = Ui.button(c, "Play something", true);
    playSomething.setOnClickListener(v -> run(Client.object("type", "play_something")));
    idleButtons.addView(playSomething, Ui.margins(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT), 0, 0, dp(10), 0));
    TextView load = Ui.button(c, "Load a saved session", false);
    load.setOnClickListener(v -> show(Page.SAVES));
    idleButtons.addView(load);
    idle.addView(idleButtons);
    now.addView(idle, Ui.wide());
  }

  private static void tint(SeekBar bar, int color) {
    android.content.res.ColorStateList list = android.content.res.ColorStateList.valueOf(color);
    bar.setProgressTintList(list);
    bar.setThumbTintList(list);
    bar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(Ui.LINE));
  }

  private double duration() {
    JSONObject song = client.nowPlaying();
    return song == null ? 0 : song.optDouble("duration", 0);
  }

  private void buildAdd() {
    LinearLayout field = Ui.row(c);
    field.setPadding(dp(12), 0, dp(4), 0);
    field.setBackground(Ui.outlined(Ui.SURFACE, Ui.LINE, dp(1), dp(10)));
    ImageView glass = new ImageView(c);
    glass.setImageDrawable(Ui.icon(c, "search", Ui.SECONDARY));
    field.addView(glass, new LinearLayout.LayoutParams(dp(18), dp(18)));
    search = new EditText(c);
    search.setHint("Search, or paste a link");
    search.setHintTextColor(Ui.FAINT);
    search.setTextColor(Ui.TEXT);
    search.setTextSize(15);
    search.setTypeface(Ui.regular(c));
    search.setBackground(null);
    search.setSingleLine(true);
    search.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    search.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
    search.setPadding(dp(10), dp(12), dp(6), dp(12));
    search.addTextChangedListener(
        new TextWatcher() {
          @Override
          public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

          @Override
          public void onTextChanged(CharSequence s, int start, int before, int count) {}

          @Override
          public void afterTextChanged(Editable s) {
            HuddleFM.main.removeCallbacks(searchLater);
            HuddleFM.main.postDelayed(searchLater, 400);
          }
        });
    search.setOnEditorActionListener(
        (v, action, event) -> {
          if (action == EditorInfo.IME_ACTION_SEARCH
              || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER)) {
            String query = search.getText().toString().trim();
            if (isLink(query)) addSong(Client.object("type", "add", "reference", query));
            else search();
            return true;
          }
          return false;
        });
    field.addView(search, Ui.weight(1));
    sparkles = Ui.iconButton(c, "sparkles", Ui.TEXT, dp(40), dp(20), "Recommendations and recent songs");
    sparkles.setOnClickListener(v -> {
      if (allowed("add")) show(Page.SUGGESTIONS);
    });
    field.addView(sparkles);
    add.addView(field, Ui.wide());
    results = Ui.column(c);
    add.addView(results, Ui.wide());
  }

  /** Invites the HuddleFM last heard in this workspace, as the huddle's Invite people would. */
  private void invite() {
    invite.setEnabled(false);
    invite.setText("Starting…");
    Invite.invite(
        (ok, error) -> {
          invite.setEnabled(true);
          invite.setText("Start HuddleFM");
          if (!ok) toast("Couldn't invite HuddleFM. Invite it with the huddle's Invite people.");
          else awayText.setText("HuddleFM is on its way.");
        });
  }

  private static boolean isLink(String text) {
    return text.startsWith("https://") || text.startsWith("http://");
  }

  private void search() {
    if (search == null) return;
    String query = search.getText().toString().trim();
    int count = ++searchCount;
    results.removeAllViews();
    if (query.isEmpty()) return;
    if (isLink(query)) {
      results.addView(
          resultRow("Add this link", query, () -> addSong(Client.object("type", "add", "reference", query))));
      return;
    }
    results.addView(note("Searching…"));
    client.command(
        Client.object("type", "search", "query", query),
        result -> {
          if (count != searchCount || page != Page.MAIN) return;
          results.removeAllViews();
          if (!result.optBoolean("ok")) {
            results.addView(note(result.optString("message", "That didn't work.")));
            return;
          }
          List<JSONObject> found = Client.list(result.optJSONArray("results"));
          if (found.isEmpty()) results.addView(note("Nothing found"));
          for (JSONObject r : found) {
            String reference = r.optString("reference");
            results.addView(
                resultRow(r.optString("label"), null, () -> addSong(Client.object("type", "add", "reference", reference))));
          }
        });
  }

  private void addSong(JSONObject command) {
    if (!client.can("add") && !client.can("add-bulk")) {
      toast(why("add"));
      return;
    }
    client.command(
        command,
        result -> {
          if (result.optBoolean("ok") && result.optJSONArray("choices") != null) {
            choose(result.optJSONArray("choices"));
            return;
          }
          if (result.optBoolean("ok")) {
            String message = result.optString("message", "");
            toast(message.isEmpty() ? "Added" : message);
            if (page == Page.MAIN && search != null) {
              search.setText("");
              results.removeAllViews();
              hideKeyboard();
            } else if (page == Page.SUGGESTIONS) show(Page.MAIN);
          } else say(result);
        });
  }

  /** Something that needs picking first, like a show's episodes. */
  private void choose(JSONArray choices) {
    List<JSONObject> options = Client.list(choices);
    String[] labels = new String[options.size()];
    for (int i = 0; i < labels.length; i++) labels[i] = options.get(i).optString("label");
    new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
        .setTitle("Pick one to add")
        .setItems(labels, (d, which) -> addSong(Client.object("type", "add", "reference", options.get(which).optString("reference"))))
        .setNegativeButton("Cancel", null)
        .show();
  }

  private View resultRow(String label, String detail, Runnable onClick) {
    LinearLayout row = Ui.row(c);
    row.setPadding(dp(10), dp(12), dp(10), dp(12));
    row.setBackground(Ui.pressable(null, dp(8)));
    ImageView plus = new ImageView(c);
    plus.setImageDrawable(Ui.icon(c, "plus", Ui.SECONDARY));
    row.addView(plus, new LinearLayout.LayoutParams(dp(18), dp(18)));
    LinearLayout words = Ui.column(c);
    words.setPadding(dp(12), 0, 0, 0);
    TextView t = Ui.text(c, label, 15, Ui.TEXT, false);
    t.setMaxLines(2);
    t.setEllipsize(android.text.TextUtils.TruncateAt.END);
    words.addView(t);
    if (detail != null) {
      TextView d = Ui.line(c, detail, 13, Ui.SECONDARY, false);
      d.setPadding(0, dp(3), 0, 0);
      words.addView(d);
    }
    row.addView(words, Ui.weight(1));
    row.setOnClickListener(v -> onClick.run());
    return row;
  }

  private TextView note(String text) {
    TextView t = Ui.text(c, text, 14, Ui.SECONDARY, false);
    t.setPadding(dp(10), dp(14), dp(10), dp(14));
    return t;
  }

  private void confirmClear() {
    if (!allowed("clear")) return;
    int queued = client.state == null ? 0 : client.state.optInt("queueLength", Client.list(client.state.optJSONArray("queue")).size());
    new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
        .setTitle("Clear the queue?")
        .setMessage(queued == 1 ? "This removes the song waiting to play." : "This removes all " + queued + " songs waiting to play.")
        .setPositiveButton("Clear", (d, w) -> run(Client.object("type", "clear")))
        .setNegativeButton("Cancel", null)
        .show();
  }

  // --- keeping the page up to date

  private void refresh() {
    if (!dialog.isShowing() && body.getChildCount() > 0 && page != Page.MAIN) return;
    Client.Presence presence = client.presence;
    JSONObject session = client.session();
    JSONObject song = client.nowPlaying();
    boolean connected = presence == Client.Presence.CONNECTED && session != null;

    if (!connected) status.setText(presence == Client.Presence.OFFLINE ? "Not in a huddle" : presence == Client.Presence.INCOMPATIBLE ? "Needs a newer patch" : "Not in this huddle");
    else if (song == null) status.setText("Nothing playing");
    else {
      String state = session.optString("state");
      int queued = client.state.optInt("queueLength", 0);
      status.setText(("paused".equals(state) ? "Paused" : "Playing") + (queued > 0 ? " · " + queued + " up next" : ""));
    }
    settingsButton.setEnabled(connected);
    settingsButton.setAlpha(connected ? 1f : 0.35f);
    if (page != Page.MAIN) {
      if (!connected) show(Page.MAIN);
      // the bot answers a change before its new state comes: the page follows the state
      else if (page == Page.SETTINGS && !settingsKey().equals(shownSettings)) {
        int y = scroll.getScrollY();
        show(Page.SETTINGS);
        scroll.post(() -> scroll.scrollTo(0, y));
      }
      return;
    }

    away.setVisibility(connected ? View.GONE : View.VISIBLE);
    for (View v : new View[] {now, add, tabs, list, lyricsBox}) v.setVisibility(connected ? View.VISIBLE : View.GONE);
    if (!connected) {
      host.setVisibility(View.GONE);
      switch (presence) {
        case OFFLINE:
          awayTitle.setText("Not in a huddle");
          awayText.setText("Join a huddle to play music in it.");
          invite.setVisibility(View.GONE);
          break;
        case INCOMPATIBLE:
          awayTitle.setText("HuddleFM needs updating");
          awayText.setText("This HuddleFM needs a newer version of the patch.");
          invite.setVisibility(View.GONE);
          break;
        default:
          awayTitle.setText("HuddleFM isn't in this huddle.");
          boolean startable = Invite.possible();
          if (!"HuddleFM is on its way.".contentEquals(awayText.getText()))
            awayText.setText(
                startable
                    ? "Start it, and its controls show up here."
                    : "Invite HuddleFM with the huddle's Invite people, and its controls show up here. Next time, you can start it from here.");
          invite.setVisibility(startable ? View.VISIBLE : View.GONE);
      }
      return;
    }

    boolean video = "video".equals(session.optString("mode"));
    // what Slack's Add songs offers before anything's typed is for music
    sparkles.setVisibility(!video && client.can("add") ? View.VISIBLE : View.GONE);
    // now playing
    playing.setVisibility(song != null ? View.VISIBLE : View.GONE);
    idle.setVisibility(song == null ? View.VISIBLE : View.GONE);
    if (song != null) {
      songTitle.setText(song.optString("title"));
      String artist = song.optString("artist", "");
      songArtist.setText(artist);
      songArtist.setVisibility(artist.isEmpty() ? View.GONE : View.VISIBLE);
      boolean live = song.optBoolean("live");
      liveBadge.setVisibility(live ? View.VISIBLE : View.GONE);
      seek.setVisibility(live ? View.INVISIBLE : View.VISIBLE);
      String url = song.optString("artwork", "");
      if (!url.equals(artworkUrl)) {
        artworkUrl = url;
        Images.load(artwork, url, dp(72), () -> artwork.setImageDrawable(placeholder()));
      }
      boolean paused = !"playing".equals(session.optString("state"));
      playPause.setImageDrawable(Ui.icon(c, paused ? "play_filled" : "pause_filled", Ui.BACKGROUND));
      playPause.setContentDescription(paused ? "Play" : "Pause");
      playPause.setAlpha(client.can("pause") ? 1f : 0.4f);
      float skip = client.can("skip") ? 1f : 0.4f;
      previous.setAlpha(skip);
      next.setAlpha(skip);
      seek.setAlpha(skip);
      if (!changingVolume) {
        int percent = session.optInt("volume", 0);
        volume.setProgress(percent);
        volumeText.setText(percent + "%");
      }
      volume.setAlpha(client.can("volume") ? 1f : 0.4f);
    } else {
      boolean canAdd = client.can("add");
      idleText.setText(canAdd ? "Search below to add a song" : "Waiting for someone to add a song");
      playSomething.setVisibility(!video && client.can(video ? "add" : "configure-settings") ? View.VISIBLE : View.GONE);
    }
    tick();

    // up next, or lyrics
    lyricsTab.setVisibility(video ? View.GONE : View.VISIBLE);
    if (video) showLyrics = false;
    int queued = client.state.optInt("queueLength", 0);
    queueTab.setText(queued > 0 ? "Up next · " + queued : "Up next");
    selectTab(queueTab, !showLyrics);
    selectTab(lyricsTab, showLyrics);
    shuffle.setVisibility(!showLyrics && queued > 1 ? View.VISIBLE : View.GONE);
    clear.setVisibility(!showLyrics && queued > 0 ? View.VISIBLE : View.GONE);
    shuffle.setAlpha(client.can("manage-queue") ? 1f : 0.4f);
    clear.setAlpha(client.can("clear") ? 1f : 0.4f);
    list.setVisibility(showLyrics ? View.GONE : View.VISIBLE);
    lyricsBox.setVisibility(showLyrics ? View.VISIBLE : View.GONE);
    if (showLyrics) showLyrics(song);
    else showQueue();

    host.setVisibility(!session.optBoolean("communism") && hostId(session) == null ? View.VISIBLE : View.GONE);
  }

  private android.graphics.drawable.Drawable placeholder() {
    GradientDrawable bg = Ui.rounded(Ui.RAISED, dp(10));
    android.graphics.drawable.Drawable note = Ui.icon(c, "music", Ui.FAINT);
    if (note == null) return bg;
    android.graphics.drawable.LayerDrawable layers = new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[] {bg, note});
    int inset = dp(22);
    layers.setLayerInset(1, inset, inset, inset, inset);
    return layers;
  }

  private void showQueue() {
    JSONArray queue = client.state.optJSONArray("queue");
    String key = (queue == null ? "" : queue.toString()) + client.can("manage-queue") + client.can("skip") + client.can("add");
    if (key.equals(shownQueue) || menuOpen) return;
    shownQueue = key;
    list.removeAllViews();
    List<JSONObject> tracks = Client.list(queue);
    if (tracks.isEmpty()) {
      TextView empty = Ui.text(c, "Nothing up next", 15, Ui.TEXT, true);
      empty.setPadding(dp(4), dp(14), 0, dp(4));
      list.addView(empty);
      TextView hint = Ui.text(c, "Songs you add show up here.", 14, Ui.SECONDARY, false);
      hint.setPadding(dp(4), 0, 0, dp(8));
      list.addView(hint);
      return;
    }
    // a long queue's state carries only its start, so moves count the whole of it
    int total = client.state.optInt("queueLength", tracks.size());
    for (int i = 0; i < tracks.size(); i++) list.addView(trackRow(tracks.get(i), i, total));
    if (total > tracks.size()) list.addView(note("and " + (total - tracks.size()) + " more"));
  }

  private View trackRow(JSONObject track, int index, int count) {
    LinearLayout row = Ui.row(c);
    row.setPadding(dp(4), dp(8), 0, dp(8));
    row.setBackground(Ui.pressable(null, dp(8)));
    ImageView art = new ImageView(c);
    art.setScaleType(ImageView.ScaleType.CENTER_CROP);
    Ui.clip(art, dp(6));
    Images.load(art, track.optString("artwork", ""), dp(44), () -> art.setImageDrawable(placeholder()));
    row.addView(art, new LinearLayout.LayoutParams(dp(44), dp(44)));
    LinearLayout words = Ui.column(c);
    words.setPadding(dp(12), 0, dp(4), 0);
    words.addView(Ui.line(c, track.optString("title"), 15, Ui.TEXT, true));
    List<String> details = new ArrayList<>();
    String artist = track.optString("artist", "");
    if (!artist.isEmpty()) details.add(artist);
    if (track.optBoolean("live")) details.add("Live");
    else if (track.optDouble("duration", 0) > 0) details.add(Ui.time(track.optDouble("duration")));
    if (track.optBoolean("automatic")) details.add("Autoplay");
    TextView detail = Ui.line(c, android.text.TextUtils.join(" · ", details), 13, Ui.SECONDARY, false);
    detail.setPadding(0, dp(4), 0, 0);
    words.addView(detail);
    row.addView(words, Ui.weight(1));
    ImageView more = Ui.iconButton(c, "ellipsis_vertical_filled", Ui.SECONDARY, dp(40), dp(18), "More actions");
    row.addView(more);
    View.OnClickListener menu = v -> trackMenu(more, track, index, count);
    more.setOnClickListener(menu);
    row.setOnClickListener(menu);
    return row;
  }

  private void trackMenu(View anchor, JSONObject track, int index, int count) {
    boolean manage = client.can("manage-queue");
    String self = client.selfUserId();
    boolean removable = manage || (self != null && self.equals(track.optString("addedBy")));
    String id = track.optString("id");
    Context dark = new android.view.ContextThemeWrapper(activity, android.R.style.Theme_DeviceDefault);
    PopupMenu popup = new PopupMenu(dark, anchor, Gravity.END);
    List<Runnable> actions = new ArrayList<>();
    android.view.Menu m = popup.getMenu();
    int group = 0;
    if (manage && client.can("skip")) {
      m.add(group, actions.size(), actions.size(), "Play now");
      actions.add(() -> playNow(track, index));
    }
    if (track.optBoolean("automatic") && client.can("add")) {
      m.add(group, actions.size(), actions.size(), "Add to queue");
      actions.add(() -> run(Client.object("type", "keep", "trackId", id)));
    }
    if (manage) {
      group++;
      if (index > 0) {
        m.add(group, actions.size(), actions.size(), "Move to start");
        actions.add(() -> run(Client.object("type", "move", "trackId", id, "position", 1)));
        m.add(group, actions.size(), actions.size(), "Move up");
        actions.add(() -> run(Client.object("type", "move", "trackId", id, "position", index)));
      }
      if (index < count - 1) {
        m.add(group, actions.size(), actions.size(), "Move down");
        actions.add(() -> run(Client.object("type", "move", "trackId", id, "position", index + 2)));
        m.add(group, actions.size(), actions.size(), "Move to end");
        actions.add(() -> run(Client.object("type", "move", "trackId", id, "position", count)));
      }
    }
    if (removable) {
      group++;
      m.add(group, actions.size(), actions.size(), "Remove from queue");
      actions.add(() -> run(Client.object("type", "remove", "trackId", id)));
    }
    if (actions.isEmpty()) {
      toast(why("manage-queue"));
      return;
    }
    if (android.os.Build.VERSION.SDK_INT >= 28) m.setGroupDividerEnabled(true);
    popup.setOnDismissListener(p -> {
      menuOpen = false;
      HuddleFM.main.post(this::refresh);
    });
    menuOpen = true;
    popup.setOnMenuItemClickListener(item -> {
      actions.get(item.getItemId()).run();
      return true;
    });
    popup.show();
  }

  /**
   * To the front, then skipped to, as the plugins' Play now. A song still downloading can't play
   * yet, so skipping would play another: it goes first instead, to play once it's ready.
   */
  private void playNow(JSONObject track, int index) {
    String title = track.optString("title");
    String status = track.optString("status", "");
    if ("failed".equals(status)) {
      toast(title + " couldn't be downloaded.");
      return;
    }
    Runnable then =
        () -> {
          if (!status.isEmpty() && !"ready".equals(status)) toast(title + " is still downloading, so it plays next.");
          else run(Client.object("type", "skip"));
        };
    if (index == 0) {
      then.run();
      return;
    }
    client.command(
        Client.object("type", "move", "trackId", track.optString("id"), "position", 1),
        result -> {
          if (result.optBoolean("ok")) then.run();
          else say(result);
        });
  }

  private void showLyrics(JSONObject song) {
    String id = song == null ? "" : song.optString("id");
    if (id.equals(lyricsFor)) return;
    lyricsFor = id;
    lyricsList.removeAllViews();
    lyricLines.clear();
    litLine = -2;
    if (song == null) {
      lyricsList.addView(note("Nothing playing"));
      return;
    }
    lyricsList.addView(note("Finding lyrics…"));
    client.command(
        Client.object("type", "lyrics", "trackId", id),
        result -> {
          if (!id.equals(lyricsFor)) return;
          lyricsList.removeAllViews();
          lyricLines.clear();
          litLine = -2;
          if (!result.optBoolean("ok")) {
            lyricsList.addView(note(result.optString("message", "Couldn't find lyrics.")));
            return;
          }
          lyrics = Client.list(result.optJSONArray("lines"));
          lyricsSynced = result.optBoolean("synced");
          if (lyrics.isEmpty()) {
            lyricsList.addView(note("No lyrics for this song."));
            return;
          }
          for (JSONObject line : lyrics) {
            String words = line.optBoolean("instrumental") ? "♪" : line.optString("text");
            TextView t = Ui.text(c, words, 20, lyricsSynced ? Ui.FAINT : Ui.TEXT, true);
            t.setTypeface(Ui.black(c));
            t.setPadding(dp(4), dp(7), dp(4), dp(7));
            if (lyricsSynced) {
              long start = line.optLong("start");
              t.setBackground(Ui.pressable(null, dp(6)));
              t.setOnClickListener(v -> {
                if (allowed("skip")) client.seek(start / 1000.0, this::say);
              });
            }
            lyricLines.add(t);
            lyricsList.addView(t);
          }
          String source = result.optString("source", "");
          if (!source.isEmpty()) lyricsList.addView(note("Lyrics from " + source));
          tick();
        });
  }

  /** Moves the time along between states. */
  private void tick() {
    HuddleFM.main.removeCallbacks(tick);
    if (!dialog.isShowing()) return;
    HuddleFM.main.postDelayed(tick, 500);
    if (page != Page.MAIN || client.state == null || seek == null) return;
    JSONObject song = client.nowPlaying();
    if (song == null) return;
    double position = client.position();
    double duration = song.optDouble("duration", 0);
    if (!seeking) {
      elapsed.setText(Ui.time(position));
      seek.setProgress(duration > 0 ? (int) Math.round(position / duration * 1000) : 0);
    }
    remaining.setText(song.optBoolean("live") ? "" : duration > 0 ? "-" + Ui.time(duration - position) : "");
    if (showLyrics && lyricsSynced && !lyricLines.isEmpty()) {
      long ms = (long) (position * 1000);
      int lit = -1;
      for (int i = 0; i < lyrics.size(); i++) if (lyrics.get(i).optLong("start") <= ms) lit = i;
      if (lit != litLine) {
        for (int i = 0; i < lyricLines.size(); i++)
          lyricLines.get(i).setTextColor(i == lit ? Ui.TEXT : i < lit ? Ui.SECONDARY : Ui.FAINT);
        litLine = lit;
        if (lit >= 0) {
          TextView line = lyricLines.get(lit);
          int y = line.getTop() - lyricsBox.getHeight() / 3;
          lyricsBox.smoothScrollTo(0, Math.max(0, y));
        }
      }
    }
  }

  // --- suggestions

  private void buildSuggestions() {
    LinearLayout box = Ui.column(c);
    body.addView(box, Ui.wide());
    box.addView(note("Finding songs…"));
    client.command(
        Client.object("type", "suggestions"),
        result -> {
          if (page != Page.SUGGESTIONS) return;
          box.removeAllViews();
          if (!result.optBoolean("ok")) {
            box.addView(note(result.optString("message", "That didn't work.")));
            return;
          }
          Map<String, List<JSONObject>> groups = new LinkedHashMap<>();
          for (JSONObject r : Client.list(result.optJSONArray("recommended"))) {
            String group = r.optString("group", "Recommended");
            if (!groups.containsKey(group)) groups.put(group, new ArrayList<>());
            groups.get(group).add(r);
          }
          boolean any = false;
          for (Map.Entry<String, List<JSONObject>> e : groups.entrySet()) {
            box.addView(heading(e.getKey()));
            for (JSONObject r : e.getValue()) box.addView(songRow(r, "recommend"));
            any = true;
          }
          List<JSONObject> recent = Client.list(result.optJSONArray("recent"));
          if (!recent.isEmpty()) {
            box.addView(heading("Recently added"));
            for (JSONObject r : recent) box.addView(songRow(r, "recent"));
            any = true;
          }
          if (!any) box.addView(note("Nothing to recommend yet. Add some songs, and HuddleFM learns what you like."));
        });
  }

  private TextView heading(String text) {
    TextView t = Ui.text(c, text.toUpperCase(), 12, Ui.SECONDARY, true);
    t.setLetterSpacing(0.06f);
    t.setPadding(dp(4), dp(18), 0, dp(6));
    return t;
  }

  private View songRow(JSONObject song, String kind) {
    LinearLayout row = Ui.row(c);
    row.setPadding(dp(4), dp(8), dp(4), dp(8));
    row.setBackground(Ui.pressable(null, dp(8)));
    ImageView art = new ImageView(c);
    art.setScaleType(ImageView.ScaleType.CENTER_CROP);
    Ui.clip(art, dp(6));
    Images.load(art, song.optString("artwork", ""), dp(44), () -> art.setImageDrawable(placeholder()));
    row.addView(art, new LinearLayout.LayoutParams(dp(44), dp(44)));
    LinearLayout words = Ui.column(c);
    words.setPadding(dp(12), 0, dp(4), 0);
    words.addView(Ui.line(c, song.optString("title"), 15, Ui.TEXT, true));
    String artist = song.optString("artist", "");
    if (!artist.isEmpty()) {
      TextView a = Ui.line(c, artist, 13, Ui.SECONDARY, false);
      a.setPadding(0, dp(4), 0, 0);
      words.addView(a);
    }
    row.addView(words, Ui.weight(1));
    ImageView plus = new ImageView(c);
    plus.setImageDrawable(Ui.icon(c, "plus", Ui.SECONDARY));
    row.addView(plus, new LinearLayout.LayoutParams(dp(20), dp(20)));
    String id = song.optString("id");
    row.setOnClickListener(v -> addSong(Client.object("type", "add", kind, id)));
    return row;
  }

  // --- saved sessions

  private void buildSaves() {
    LinearLayout box = Ui.column(c);
    body.addView(box, Ui.wide());
    box.addView(note("Finding saved sessions…"));
    client.command(
        Client.object("type", "saves"),
        result -> {
          if (page != Page.SAVES) return;
          box.removeAllViews();
          if (!result.optBoolean("ok")) {
            box.addView(note(result.optString("message", "That didn't work.")));
            return;
          }
          List<JSONObject> saves = Client.list(result.optJSONArray("saves"));
          if (saves.isEmpty()) box.addView(note("No saved sessions yet. End a session and save it to find it here."));
          DateFormat format = DateFormat.getDateInstance(DateFormat.MEDIUM);
          for (JSONObject save : saves) {
            LinearLayout row = Ui.column(c);
            row.setPadding(dp(8), dp(12), dp(8), dp(12));
            row.setBackground(Ui.pressable(null, dp(8)));
            row.addView(Ui.line(c, save.optString("name"), 15, Ui.TEXT, true));
            int songs = save.optInt("songs");
            String where = "channel".equals(save.optString("owner")) ? "This channel" : "Your account";
            TextView d = Ui.line(c, songs + (songs == 1 ? " song" : " songs") + " · " + where + " · " + format.format(new Date(save.optLong("savedAt"))), 13, Ui.SECONDARY, false);
            d.setPadding(0, dp(4), 0, 0);
            row.addView(d);
            row.setOnClickListener(v -> load(save));
            box.addView(row);
          }
        });
  }

  private void load(JSONObject save) {
    // drawn in the dialog's dark theme, not the huddle's
    CheckBox forget = new CheckBox(new android.view.ContextThemeWrapper(activity, android.R.style.Theme_DeviceDefault));
    forget.setText("Delete it after loading");
    LinearLayout wrap = Ui.column(activity);
    wrap.setPadding(dp(20), dp(8), dp(20), 0);
    wrap.addView(forget);
    AlertDialog.Builder b =
        new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Load " + save.optString("name") + "?")
            .setPositiveButton(
                "Load",
                (d, w) -> {
                  JSONObject command = Client.object("type", "load", "saveId", save.optString("id"));
                  if (forget.isChecked()) Client.put(command, "forget", true);
                  client.command(command, result -> {
                    say(result);
                    if (result.optBoolean("ok")) show(Page.MAIN);
                  });
                })
            .setNegativeButton("Cancel", null);
    if (save.optBoolean("deletable")) b.setView(wrap);
    b.show();
  }

  // --- settings

  private String settingsKey() {
    JSONObject state = client.state;
    JSONObject session = client.session();
    return (state == null ? "" : String.valueOf(state.optJSONArray("settings")))
        + (session == null ? "" : session.optString("hostId") + session.optBoolean("communism"))
        + (client.you == null ? "" : client.you.toString());
  }

  private void buildSettings() {
    shownSettings = settingsKey();
    JSONObject state = client.state;
    if (state == null) return;
    List<JSONObject> all = Client.list(state.optJSONArray("settings"));
    String[][] groups = {{"session", "Session"}, {"host", "Host"}};
    for (String[] group : groups) {
      List<JSONObject> fields = new ArrayList<>();
      for (JSONObject f : all) if (group[0].equals(f.optString("tab")) && allowedField(f)) fields.add(f);
      if (fields.isEmpty()) continue;
      body.addView(heading(group[1]));
      addFields(fields);
    }
    List<JSONObject> own = client.you == null ? new ArrayList<>() : Client.list(client.you.optJSONArray("settings"));
    if (!own.isEmpty()) {
      body.addView(heading("You"));
      addFields(own);
    }
    if (body.getChildCount() == 0) body.addView(note("You can't change this session's settings. Ask the host."));
    // what's this phone's own, not the session's: kept here, and shown to no one else
    body.addView(heading("On this phone"));
    LinearLayout phone = Ui.column(c);
    phone.setBackground(Ui.rounded(Ui.SURFACE, dp(12)));
    phone.addView(
        switchRow(
            "Show in media controls",
            "The song in Android's media controls, with play, pause and skip.",
            Media.enabled(),
            Media::setEnabled));
    body.addView(phone, Ui.wide());

    if (client.can("end-session")) {
      TextView end = Ui.button(c, "End session", false);
      end.setTextColor(Ui.DANGER);
      end.setOnClickListener(v -> end());
      body.addView(end, Ui.margins(Ui.wide(), 0, dp(26), 0, 0));
    }

    TextView more = Ui.text(c, "Accounts and more are in HuddleFM's Settings in Slack, on its message in the huddle's thread.", 13, Ui.FAINT, false);
    more.setPadding(dp(4), dp(18), dp(4), 0);
    body.addView(more);
  }

  private boolean allowedField(JSONObject field) {
    switch (field.optString("requires")) {
      case "volume":
        return client.can("volume");
      case "configure":
        return client.can("configure-settings");
      case "admin":
        return client.admin();
      default:
        return true;
    }
  }

  private void addFields(List<JSONObject> fields) {
    LinearLayout card = Ui.column(c);
    card.setBackground(Ui.rounded(Ui.SURFACE, dp(12)));
    boolean first = true;
    for (JSONObject field : fields) {
      String section = field.optString("section", "");
      if (!section.isEmpty()) {
        TextView s = Ui.text(c, section, 13, Ui.SECONDARY, true);
        s.setPadding(dp(14), dp(14), dp(14), dp(2));
        card.addView(s);
      } else if (!first) card.addView(Ui.divider(c), Ui.margins(Ui.wide(), dp(14), 0, 0, 0));
      first = false;
      card.addView(fieldRow(field));
    }
    body.addView(card, Ui.wide());
  }

  private View fieldRow(JSONObject field) {
    LinearLayout row = Ui.row(c);
    row.setPadding(dp(14), dp(12), dp(14), dp(12));
    row.setBackground(Ui.pressable(null, dp(12)));
    LinearLayout words = Ui.column(c);
    words.addView(Ui.text(c, field.optString("label"), 15, Ui.TEXT, true));
    String hint = field.optString("hint", "");
    String kind = field.optString("kind");
    TextView value = null;
    switch (kind) {
      case "select":
        value = valueText(label(field.optJSONArray("options"), field.optString("value")));
        row.setOnClickListener(v -> pickOne(field));
        break;
      case "number":
        value = valueText(field.optString("value"));
        row.setOnClickListener(v -> typeNumber(field));
        break;
      case "toggle":
        {
          Switch toggle = new Switch(c);
          toggle.setChecked(field.optBoolean("value"));
          int[][] states = {{android.R.attr.state_checked}, {}};
          toggle.setThumbTintList(new android.content.res.ColorStateList(states, new int[] {Color.WHITE, Ui.SECONDARY}));
          toggle.setTrackTintList(new android.content.res.ColorStateList(states, new int[] {Ui.ACCENT, Ui.LINE}));
          String text = field.optString("text", "");
          if (!text.isEmpty() && hint.isEmpty()) hint = text;
          toggle.setOnCheckedChangeListener((b, on) -> change(field, on));
          row.setOnClickListener(v -> toggle.toggle());
          row.addView(words, Ui.weight(1));
          row.addView(toggle);
          if (!hint.isEmpty()) words.addView(hintText(hint));
          return row;
        }
      case "multi":
        {
          JSONArray chosen = field.optJSONArray("value");
          int n = chosen == null ? 0 : chosen.length();
          String summary = n == 0 ? "None" : n == 1 ? label(field.optJSONArray("options"), chosen.optString(0)) : n + " chosen";
          String preset = presetFor(field);
          value = valueText(preset != null ? preset : summary);
          row.setOnClickListener(v -> pickMany(field));
          break;
        }
      default:
        {
          String user = field.isNull("value") ? "" : field.optString("value", "");
          String self = client.selfUserId();
          value = valueText(user.isEmpty() ? "Nobody" : user.equals(self) ? "You" : "Someone else");
          String extra = "Change it in Slack.";
          hint = hint.isEmpty() ? extra : hint + " " + extra;
        }
    }
    if (!hint.isEmpty()) words.addView(hintText(hint));
    row.addView(words, Ui.weight(1));
    if (value != null) row.addView(value);
    return row;
  }

  interface Toggled {
    void toggled(boolean on);
  }

  /** A row with a switch, drawn as the bot's toggle settings are. */
  private View switchRow(String label, String hint, boolean on, Toggled toggled) {
    LinearLayout row = Ui.row(c);
    row.setPadding(dp(14), dp(12), dp(14), dp(12));
    row.setBackground(Ui.pressable(null, dp(12)));
    LinearLayout words = Ui.column(c);
    words.addView(Ui.text(c, label, 15, Ui.TEXT, true));
    words.addView(hintText(hint));
    row.addView(words, Ui.weight(1));
    Switch toggle = new Switch(c);
    toggle.setChecked(on);
    tintSwitch(toggle);
    toggle.setOnCheckedChangeListener((b, value) -> toggled.toggled(value));
    row.setOnClickListener(v -> toggle.toggle());
    row.addView(toggle);
    return row;
  }

  private static void tintSwitch(Switch toggle) {
    int[][] states = {{android.R.attr.state_checked}, {}};
    toggle.setThumbTintList(new android.content.res.ColorStateList(states, new int[] {Color.WHITE, Ui.SECONDARY}));
    toggle.setTrackTintList(new android.content.res.ColorStateList(states, new int[] {Ui.ACCENT, Ui.LINE}));
  }

  private TextView hintText(String hint) {
    TextView h = Ui.text(c, hint, 13, Ui.SECONDARY, false);
    h.setPadding(0, dp(4), dp(10), 0);
    return h;
  }

  private TextView valueText(String text) {
    TextView v = Ui.line(c, text, 14, Ui.LINK, true);
    v.setMaxWidth(dp(150));
    v.setPadding(dp(10), 0, 0, 0);
    return v;
  }

  private static String label(JSONArray options, String value) {
    for (JSONObject o : Client.list(options)) if (o.optString("value").equals(value)) return o.optString("label");
    return value;
  }

  private static String presetFor(JSONObject field) {
    JSONArray presets = field.optJSONArray("presets");
    JSONArray chosen = field.optJSONArray("value");
    if (presets == null || chosen == null) return null;
    List<String> have = Client.strings(chosen);
    for (JSONObject p : Client.list(presets)) {
      List<String> want = Client.strings(p.optJSONArray("permissions"));
      if (want.size() == have.size() && want.containsAll(have)) return p.optString("label");
    }
    return null;
  }

  private void change(JSONObject field, Object value) {
    // on success the bot's new state redraws the page; a refusal puts it back as it was
    client.setting(field.optString("id"), value, result -> {
      say(result);
      if (!result.optBoolean("ok") && page == Page.SETTINGS) show(Page.SETTINGS);
    });
  }

  private void pickOne(JSONObject field) {
    List<JSONObject> options = Client.list(field.optJSONArray("options"));
    String[] labels = new String[options.size()];
    int checked = -1;
    for (int i = 0; i < labels.length; i++) {
      JSONObject o = options.get(i);
      String description = o.optString("description", "");
      labels[i] = o.optString("label") + (description.isEmpty() ? "" : " — " + description);
      if (o.optString("value").equals(field.optString("value"))) checked = i;
    }
    new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
        .setTitle(field.optString("label"))
        .setSingleChoiceItems(labels, checked, (d, which) -> {
          d.dismiss();
          change(field, options.get(which).optString("value"));
        })
        .setNegativeButton("Cancel", null)
        .show();
  }

  /** A number typed in, between the field's min and max. */
  private void typeNumber(JSONObject field) {
    double min = field.optDouble("min", 0);
    double max = field.optDouble("max", 100);
    EditText input = new EditText(c);
    input.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
    input.setText(field.optString("value"));
    input.setSelectAllOnFocus(true);
    FrameLayout frame = new FrameLayout(c);
    frame.setPadding(dp(20), dp(8), dp(20), 0);
    frame.addView(input);
    new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
        .setTitle(field.optString("label"))
        .setView(frame)
        .setPositiveButton("Set", (d, which) -> {
          double number;
          try {
            number = Double.parseDouble(input.getText().toString().trim());
          } catch (NumberFormatException e) {
            number = Double.NaN;
          }
          if (!(number >= min && number <= max)) {
            Toast.makeText(c, "Enter a number from " + plain(min) + " to " + plain(max) + ".", Toast.LENGTH_SHORT).show();
            return;
          }
          change(field, number);
        })
        .setNegativeButton("Cancel", null)
        .show();
  }

  /** A number without a trailing ".0" when it's whole. */
  private static String plain(double number) {
    return number == Math.rint(number) ? String.valueOf((long) number) : String.valueOf(number);
  }

  private void pickMany(JSONObject field) {
    JSONArray presets = field.optJSONArray("presets");
    if (presets != null && presets.length() > 0) {
      List<JSONObject> list = Client.list(presets);
      String[] labels = new String[list.size() + 1];
      for (int i = 0; i < list.size(); i++) labels[i] = list.get(i).optString("label");
      labels[list.size()] = "Choose each…";
      new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
          .setTitle(field.optString("label"))
          .setItems(labels, (d, which) -> {
            if (which < list.size())
              client.preset(list.get(which).optString("value"), this::say);
            else chooseEach(field);
          })
          .setNegativeButton("Cancel", null)
          .show();
    } else chooseEach(field);
  }

  private void chooseEach(JSONObject field) {
    List<JSONObject> options = Client.list(field.optJSONArray("options"));
    List<String> chosen = Client.strings(field.optJSONArray("value"));
    String[] labels = new String[options.size()];
    boolean[] checked = new boolean[options.size()];
    for (int i = 0; i < labels.length; i++) {
      labels[i] = options.get(i).optString("label");
      checked[i] = chosen.contains(options.get(i).optString("value"));
    }
    new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
        .setTitle(field.optString("label"))
        .setMultiChoiceItems(labels, checked, (d, which, on) -> checked[which] = on)
        .setPositiveButton("Save", (d, w) -> {
          JSONArray value = new JSONArray();
          for (int i = 0; i < checked.length; i++) if (checked[i]) value.put(options.get(i).optString("value"));
          change(field, value);
        })
        .setNegativeButton("Cancel", null)
        .show();
  }

  private void end() {
    if (!allowed("end-session")) return;
    String[] choices = {"Don't save", "Save to this channel", "Save to my account"};
    String[] saves = {"none", "channel", "user"};
    new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
        .setTitle("End session?")
        .setItems(choices, (d, which) -> {
          client.command(Client.object("type", "end", "save", saves[which]), result -> {
            say(result);
            if (result.optBoolean("ok")) show(Page.MAIN);
          });
        })
        .setNegativeButton("Cancel", null)
        .show();
  }

  private void hideKeyboard() {
    if (search == null) return;
    InputMethodManager input = (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
    if (input != null) input.hideSoftInputFromWindow(search.getWindowToken(), 0);
    search.clearFocus();
  }
}
