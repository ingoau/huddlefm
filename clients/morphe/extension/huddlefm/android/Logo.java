package huddlefm.android;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

/** HuddleFM's logo, the same 28 by 28 pixel art as clients/core/logo.ts, drawn unfiltered. */
final class Logo {
  private static final String PNG =
      "iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAYAAAByDd+UAAABM0lEQVR4nL2WvQ6CQAzHy4WRkVGfgM3ExcFnYPIRWNydmd1ZeAQnnsHBhcSNJ8DR0R0HUzzuel9I/SckwF3za3ttAUBSU3RDU3QDMEpQLzmhGjCvs4gLpkmOjDu1k/NjT6kK4ExrbAOlycoY6fP1mOUUaYSgtuqNhtvjehZY25wmq8EGosAhUC2FJhhGBKBHHgL1PjOXKCBV7WPjq9Ht9pvJxvJ8GC9q3dfZ2LRwu96thq51lFz5TdEN2mgLKRjZpq16ryhjAD2dVFGEOqaeHz6TX4u5wihNsMWBqtTJlddZZCyapUF47xVhW/VQni6LOMOaUkreKW2rfqxW2/hzjbigM5zTo6oEwGcOUr0WKp/mFwDfxv8HVKibuaGCGmucULItEPorGKEyOHL9UrhawVfYMm8sGrhQSGkH+AAAAABJRU5ErkJggg==";
  private static Bitmap bitmap;

  private Logo() {}

  static Bitmap bitmap() {
    if (bitmap == null) {
      byte[] png = Base64.decode(PNG, Base64.DEFAULT);
      bitmap = BitmapFactory.decodeByteArray(png, 0, png.length);
    }
    return bitmap;
  }
}
