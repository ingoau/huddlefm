// Small text helpers the panel shares.

/** Seconds as `m:ss`, or `h:mm:ss` past an hour. */
export function clock(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "--:--";
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A search box's text that is a link, to add as it is. */
export function isLink(text: string) {
  return /^https?:\/\/\S+$/i.test(text.trim());
}
