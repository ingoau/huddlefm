package huddlefm.android;

import android.content.Context;
import android.view.View;
import androidx.compose.runtime.Composer;
import androidx.compose.ui.viewinterop.AndroidView_androidKt;
import kotlin.jvm.functions.Function1;

/**
 * HuddleFM in the huddle. The patch calls {@link #card} in the huddle's column, between its
 * tiles and its bottom bar, so the card sits just above the bar's buttons and the tiles make room
 * for it.
 */
public final class Bar {
  private static final Function1<Context, View> factory = Card::new;

  private Bar() {}

  /** Puts the now playing card in the bar; called by the bar's composable with its composer. */
  public static void card(Object composer) {
    // AndroidView(factory, modifier, update): the modifier and update left as they default
    try {
      AndroidView_androidKt.AndroidView(factory, null, null, (Composer) composer, 0, 6);
    } catch (LinkageError e) {
      // an AndroidView this build doesn't have fails before it starts drawing anything, so
      // there's simply no card
      HuddleFM.log("Couldn't draw the card: " + e);
    }
  }
}
