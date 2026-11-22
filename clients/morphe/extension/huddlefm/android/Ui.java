package huddlefm.android;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Drawing in the huddle's look: Slack's dark palette, its Lato and its icons. */
final class Ui {
  // Slack's dark theme, as the huddle screen uses it
  static final int BACKGROUND = 0xFF1A1D21;
  static final int SURFACE = 0xFF222529;
  static final int RAISED = 0xFF2C2D30;
  static final int LINE = 0xFF35373B;
  static final int TEXT = 0xFFF8F8F8;
  static final int SECONDARY = 0xFFABABAD;
  static final int FAINT = 0xFF6F7073;
  static final int ACCENT = 0xFF2BAC76;
  static final int LINK = 0xFF1D9BD1;
  static final int DANGER = 0xFFE01E5A;

  private static Typeface regular;
  private static Typeface bold;
  private static Typeface black;

  private Ui() {}

  static int dp(Context context, float value) {
    return Math.round(
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, context.getResources().getDisplayMetrics()));
  }

  static int drawable(String name) {
    Context c = HuddleFM.context();
    return c == null ? 0 : c.getResources().getIdentifier(name, "drawable", c.getPackageName());
  }

  static Drawable icon(Context context, String name, int color) {
    int id = drawable(name);
    if (id == 0) return null;
    Drawable d = context.getDrawable(id);
    if (d == null) return null;
    d = d.mutate();
    d.setTint(color);
    return d;
  }

  private static Typeface font(Context context, String name, int style) {
    try {
      int id = context.getResources().getIdentifier(name, "font", context.getPackageName());
      if (id != 0) return context.getResources().getFont(id);
    } catch (Throwable ignored) {
    }
    return Typeface.create(Typeface.SANS_SERIF, style);
  }

  static Typeface regular(Context c) {
    if (regular == null) regular = font(c, "lato_regular", Typeface.NORMAL);
    return regular;
  }

  static Typeface bold(Context c) {
    if (bold == null) bold = font(c, "lato_bold", Typeface.BOLD);
    return bold;
  }

  static Typeface black(Context c) {
    if (black == null) black = font(c, "lato_black", Typeface.BOLD);
    return black;
  }

  static TextView text(Context c, CharSequence value, float size, int color, boolean strong) {
    TextView t = new TextView(c);
    t.setText(value);
    t.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
    t.setTextColor(color);
    t.setTypeface(strong ? bold(c) : regular(c));
    t.setIncludeFontPadding(false);
    t.setLineSpacing(0, 1.15f);
    return t;
  }

  static TextView line(Context c, CharSequence value, float size, int color, boolean strong) {
    TextView t = text(c, value, size, color, strong);
    t.setSingleLine(true);
    t.setEllipsize(TextUtils.TruncateAt.END);
    return t;
  }

  static GradientDrawable rounded(int color, float radius) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(color);
    d.setCornerRadius(radius);
    return d;
  }

  static GradientDrawable outlined(int fill, int stroke, int width, float radius) {
    GradientDrawable d = rounded(fill, radius);
    d.setStroke(width, stroke);
    return d;
  }

  /** A touch ripple over [content], clipped to [radius]. */
  static Drawable pressable(Drawable content, float radius) {
    GradientDrawable mask = rounded(Color.WHITE, radius);
    return new RippleDrawable(ColorStateList.valueOf(0x33FFFFFF), content, mask);
  }

  static void clip(View view, float radius) {
    view.setOutlineProvider(
        new ViewOutlineProvider() {
          @Override
          public void getOutline(View v, Outline outline) {
            outline.setRoundRect(0, 0, v.getWidth(), v.getHeight(), radius);
          }
        });
    view.setClipToOutline(true);
  }

  /** A round icon button, [size] across, its icon [iconSize] across. */
  static ImageView iconButton(Context c, String icon, int color, int size, int iconSize, String label) {
    ImageView b = new ImageView(c);
    b.setImageDrawable(icon(c, icon, color));
    b.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
    int pad = (size - iconSize) / 2;
    b.setPadding(pad, pad, pad, pad);
    b.setBackground(pressable(null, size / 2f));
    b.setContentDescription(label);
    b.setLayoutParams(new LinearLayout.LayoutParams(size, size));
    b.setClickable(true);
    b.setFocusable(true);
    return b;
  }

  /** A pill-shaped button with a label, filled or outlined. */
  static TextView button(Context c, String label, boolean primary) {
    TextView b = text(c, label, 15, primary ? Color.WHITE : TEXT, true);
    b.setGravity(Gravity.CENTER);
    int h = dp(c, 12);
    int w = dp(c, 18);
    b.setPadding(w, h, w, h);
    float r = dp(c, 8);
    b.setBackground(
        pressable(primary ? rounded(ACCENT, r) : outlined(0, LINE, dp(c, 1), r), r));
    b.setClickable(true);
    b.setFocusable(true);
    return b;
  }

  static View divider(Context c) {
    View v = new View(c);
    v.setBackgroundColor(LINE);
    v.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(c, 0.5f))));
    return v;
  }

  static LinearLayout row(Context c) {
    LinearLayout l = new LinearLayout(c);
    l.setOrientation(LinearLayout.HORIZONTAL);
    l.setGravity(Gravity.CENTER_VERTICAL);
    return l;
  }

  static LinearLayout column(Context c) {
    LinearLayout l = new LinearLayout(c);
    l.setOrientation(LinearLayout.VERTICAL);
    return l;
  }

  static LinearLayout.LayoutParams weight(float weight) {
    return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, weight);
  }

  static LinearLayout.LayoutParams wide() {
    return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
  }

  static LinearLayout.LayoutParams margins(LinearLayout.LayoutParams p, int l, int t, int r, int b) {
    p.setMargins(l, t, r, b);
    return p;
  }

  static FrameLayout.LayoutParams frame(int w, int h, int gravity) {
    return new FrameLayout.LayoutParams(w, h, gravity);
  }

  /** Seconds as m:ss, or h:mm:ss. */
  static String time(double seconds) {
    long s = Math.max(0, Math.round(Math.floor(seconds)));
    long h = s / 3600;
    long m = (s % 3600) / 60;
    long r = s % 60;
    return h > 0 ? String.format("%d:%02d:%02d", h, m, r) : String.format("%d:%02d", m, r);
  }
}
