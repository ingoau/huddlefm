package huddlefm.android;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.lang.ref.WeakReference;

/** Where the patch starts, and what the rest share: the app, its activities and the client. */
public final class HuddleFM {
  static final Handler main = new Handler(Looper.getMainLooper());
  static final Client client = new Client();
  static Application app;
  private static WeakReference<Activity> resumed = new WeakReference<>(null);

  private HuddleFM() {}

  /** Called from SlackApp.onCreate. */
  public static void init(Application application) {
    if (app != null) return;
    app = application;
    try {
      application.registerActivityLifecycleCallbacks(
          new Application.ActivityLifecycleCallbacks() {
            @Override
            public void onActivityResumed(Activity activity) {
              resumed = new WeakReference<>(activity);
            }

            @Override
            public void onActivityPaused(Activity activity) {
              if (activity.isInPictureInPictureMode()) Panel.hide(activity);
            }

            @Override
            public void onActivityCreated(Activity activity, Bundle state) {}

            @Override
            public void onActivityStarted(Activity activity) {}

            @Override
            public void onActivityStopped(Activity activity) {
              Panel.hide(activity);
            }

            @Override
            public void onActivitySaveInstanceState(Activity activity, Bundle state) {}

            @Override
            public void onActivityDestroyed(Activity activity) {
              if (resumed.get() == activity) resumed = new WeakReference<>(null);
              Panel.hide(activity);
            }
          });
      Media.init(application);
      log("HuddleFM " + Version.NAME + " is ready");
    } catch (Throwable t) {
      log("Couldn't start: " + t);
    }
  }

  /** The activity in front, for the panel to show over. */
  static Activity activity() {
    return resumed.get();
  }

  static Context context() {
    return app;
  }

  static void log(String text) {
    Log.i("HuddleFM", text);
  }
}
