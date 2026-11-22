package huddlefm.android;

import android.graphics.drawable.BitmapDrawable;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import org.json.JSONObject;
import slack.uikit.text.CharSequenceResource;

/**
 * HuddleFM's row in the huddle's More Options, after Slack's own Play music. The patch hands
 * {@link #add} the list as Slack builds it, and {@link #click} each click on a row.
 */
public final class Menu {
  static final String ID = "id_huddlefm";

  private Menu() {}

  /** Adds HuddleFM's row after [music], Slack's Play music row, which it's made like. */
  public static void add(List<Object> list, Object music) {
    try {
      Object row = row(music);
      if (row != null) list.add(row);
    } catch (Throwable t) {
      HuddleFM.log("Couldn't add HuddleFM to More Options: " + t);
    }
  }

  private static Object row(Object music) throws ReflectiveOperationException {
    Class<?> type = music.getClass();
    Object subtitle = subtitle();
    Object icon = icon();
    // id, title, subtitle, icon, content description, bundle, type, options, accessories,
    // section header, section: Play music's for the rest, but no NEW badge
    Object[] values = {
      ID,
      new CharSequenceResource("HuddleFM"),
      subtitle,
      icon != null ? icon : get(music, "icon"),
      null,
      get(music, "bundleWrapper"),
      get(music, "type"),
      get(music, "options"),
      null,
      get(music, "sectionHeaderId"),
      get(music, "belongsToSectionId"),
    };
    for (Constructor<?> c : type.getDeclaredConstructors()) {
      Class<?>[] params = c.getParameterTypes();
      if (params.length == 11) return c.newInstance(values);
      if (params.length == 12 && params[11] == int.class) {
        Object[] withMask = new Object[12];
        System.arraycopy(values, 0, withMask, 0, 11);
        withMask[11] = 0;
        return c.newInstance(withMask);
      }
    }
    return null;
  }

  /** What's playing, while HuddleFM is in the huddle. */
  private static Object subtitle() {
    Client client = HuddleFM.client;
    if (client.presence != Client.Presence.CONNECTED) return new CharSequenceResource("Play music together");
    JSONObject song = client.nowPlaying();
    if (song == null) return new CharSequenceResource("Nothing playing");
    String artist = song.optString("artist", "");
    return new CharSequenceResource(song.optString("title") + (artist.isEmpty() ? "" : " · " + artist));
  }

  /** HuddleFM's logo, drawn as Slack draws images in its lists. */
  private static Object icon() {
    try {
      android.content.res.Resources res = HuddleFM.context().getResources();
      // the size of Slack's icons beside it
      int size = Math.round(24 * res.getDisplayMetrics().density);
      BitmapDrawable logo =
          new BitmapDrawable(res, android.graphics.Bitmap.createScaledBitmap(Logo.bitmap(), size, size, true));
      Class<?> image = Class.forName("slack.uikit.components.SKImageResource$DrawableImage");
      return image.getConstructor(android.graphics.drawable.Drawable.class).newInstance(logo);
    } catch (Throwable t) {
      return null;
    }
  }

  /** A click on a More Options row, in Slack's handler: true when it was HuddleFM's. */
  public static boolean click(Object handler) {
    try {
      // the handler is a generated coroutine, maybe merged with others, so what it holds is
      // found by its type, not by the names R8 gave it
      Object event = held(handler, "slack.features.huddles.settings.circuit.HuddleSettingsScreen$Event$OnItemClicked");
      if (event == null || !ID.equals(get(event, "itemId"))) return false;
      // close More Options, as Slack does after its own rows
      Object presenter = held(handler, "slack.features.huddles.settings.circuit.HuddleSettingsPresenter");
      Object navigator = presenter == null ? null : get(presenter, "navigator");
      if (navigator != null) {
        for (Method m : navigator.getClass().getMethods())
          if (m.getName().equals("pop") && m.getParameterTypes().length == 1) {
            m.invoke(navigator, (Object) null);
            break;
          }
      }
      HuddleFM.main.postDelayed(Panel::open, 250);
      return true;
    } catch (Throwable t) {
      HuddleFM.log("Couldn't handle a More Options click: " + t);
      return false;
    }
  }

  /** What [object] holds of the class named [type], in any of its fields, or null. */
  private static Object held(Object object, String type) {
    for (Class<?> c = object.getClass(); c != null && c != Object.class; c = c.getSuperclass())
      for (Field f : c.getDeclaredFields()) {
        if (java.lang.reflect.Modifier.isStatic(f.getModifiers()) || f.getType().isPrimitive()) continue;
        try {
          f.setAccessible(true);
          Object value = f.get(object);
          if (value != null && value.getClass().getName().equals(type)) return value;
        } catch (Throwable ignored) {
        }
      }
    return null;
  }

  private static Object get(Object object, String name) throws ReflectiveOperationException {
    for (Class<?> c = object.getClass(); c != null; c = c.getSuperclass()) {
      try {
        Field f = c.getDeclaredField(name);
        f.setAccessible(true);
        return f.get(object);
      } catch (NoSuchFieldException ignored) {
      }
    }
    throw new NoSuchFieldException(name);
  }
}
