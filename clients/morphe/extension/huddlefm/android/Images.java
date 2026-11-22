package huddlefm.android;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.LruCache;
import android.widget.ImageView;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Artwork, fetched off the main thread and kept for a while. */
final class Images {
  private static final ExecutorService pool = Executors.newFixedThreadPool(3);
  private static final LruCache<String, Bitmap> cache =
      new LruCache<String, Bitmap>(12 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
          return value.getByteCount();
        }
      };

  private Images() {}

  /** Shows the artwork at [url] in [view], or [placeholder] until it's there. */
  static void load(ImageView view, String url, int size, Runnable placeholder) {
    view.setTag(url);
    if (url == null || url.isEmpty() || !url.startsWith("https://")) {
      placeholder.run();
      return;
    }
    Bitmap cached = cache.get(url);
    if (cached != null) {
      view.setImageBitmap(cached);
      return;
    }
    placeholder.run();
    pool.execute(
        () -> {
          Bitmap bitmap = fetch(url, size);
          if (bitmap == null) return;
          cache.put(url, bitmap);
          HuddleFM.main.post(
              () -> {
                if (url.equals(view.getTag())) view.setImageBitmap(bitmap);
              });
        });
  }

  interface Loaded {
    void loaded(Bitmap bitmap);
  }

  /** The artwork at [url], on the main thread, or nothing if it can't be had. */
  static void get(String url, int size, Loaded loaded) {
    if (url == null || !url.startsWith("https://")) return;
    Bitmap cached = cache.get(url);
    if (cached != null) {
      loaded.loaded(cached);
      return;
    }
    pool.execute(
        () -> {
          Bitmap bitmap = fetch(url, size);
          if (bitmap == null) return;
          cache.put(url, bitmap);
          HuddleFM.main.post(() -> loaded.loaded(bitmap));
        });
  }

  private static Bitmap fetch(String url, int size) {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(url).openConnection();
      connection.setConnectTimeout(10_000);
      connection.setReadTimeout(15_000);
      if (connection.getResponseCode() != 200) return null;
      byte[] bytes;
      try (InputStream in = connection.getInputStream()) {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int n;
        while ((n = in.read(buffer)) > 0) {
          out.write(buffer, 0, n);
          if (out.size() > 8 * 1024 * 1024) return null;
        }
        bytes = out.toByteArray();
      }
      BitmapFactory.Options bounds = new BitmapFactory.Options();
      bounds.inJustDecodeBounds = true;
      BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
      BitmapFactory.Options options = new BitmapFactory.Options();
      int sample = 1;
      while (bounds.outWidth / (sample * 2) >= size && bounds.outHeight / (sample * 2) >= size) sample *= 2;
      options.inSampleSize = sample;
      return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
    } catch (Throwable t) {
      return null;
    } finally {
      if (connection != null) connection.disconnect();
    }
  }
}
