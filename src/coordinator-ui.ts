import { safeError } from "./error-message.ts";

export const permissionLabels = {
  add: "Add songs",
  "add-bulk": "Add albums, playlists, and link lists",
  "remove-own": "Remove songs they added",
  "manage-queue": "Manage queue",
  skip: "Skip songs",
  pause: "Pause or resume",
  volume: "Change volume",
  "configure-settings": "Configure settings",
  clear: "Clear queue",
  "end-session": "End session",
};

export function auditTrack(track: {
  id: string;
  sourceId: string;
  title: string;
  artist: string;
  requesterId: string;
  automatic?: boolean;
}) {
  return {
    trackId: track.id,
    sourceId: track.sourceId,
    title: track.title,
    artist: track.artist,
    requesterId: track.requesterId,
    origin: track.automatic ? "autoplay" : "manual",
  };
}

// What an Undo button carries. A like is stored against the song rather than
// the queue row, and taken back long after the entry — and often the session
// itself — is gone, so the button has to carry everything the undo needs:
// the song, the session it happened in for the audit trail, and the lane the
// pick came from so taking a like back is attributable like the like was.
export function likeValue(like: {
  sessionId: string;
  title: string;
  artist: string;
  discovery?: boolean;
}) {
  return JSON.stringify({
    sessionId: like.sessionId,
    title: like.title,
    artist: like.artist,
    ...(like.discovery === undefined ? {} : { discovery: like.discovery }),
  });
}

export function parseLikeValue(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return undefined;
    const { sessionId, title, artist, discovery } = parsed as {
      sessionId?: unknown;
      title?: unknown;
      artist?: unknown;
      discovery?: unknown;
    };
    if (
      typeof sessionId !== "string" ||
      typeof title !== "string" ||
      typeof artist !== "string"
    )
      return undefined;
    return {
      sessionId,
      title,
      artist,
      ...(typeof discovery === "boolean" ? { discovery } : {}),
    };
  } catch {
    return undefined;
  }
}

export function safeAuditError(error: unknown) {
  return safeError(error);
}

export function plain(text: string) {
  return { type: "plain_text", text: text.slice(0, 150) };
}

export function mrkdwn(text: string) {
  return { type: "mrkdwn", text };
}

export function capitalize(text: string) {
  return text[0]!.toUpperCase() + text.slice(1);
}

// Items that belong in a block list only when `condition` holds.
export function when(condition: unknown, ...items: unknown[]) {
  return condition ? items : [];
}

export function section(text: string, blockId?: string) {
  return {
    type: "section",
    ...(blockId ? { block_id: blockId } : {}),
    text: mrkdwn(text),
  };
}

export function context(blockId: string, text: string) {
  return { type: "context", block_id: blockId, elements: [mrkdwn(text)] };
}

export function actions(blockId: string, elements: unknown[]) {
  return { type: "actions", block_id: blockId, elements };
}

export function button(
  actionId: string,
  text: ReturnType<typeof plain>,
  extra: Record<string, unknown> = {},
) {
  return { type: "button", action_id: actionId, text, ...extra };
}

export function input(
  blockId: string,
  label: string,
  element: unknown,
  options: { optional?: boolean; hint?: string } = {},
) {
  return {
    type: "input",
    block_id: blockId,
    ...(options.optional === undefined ? {} : { optional: options.optional }),
    label: plain(label),
    ...(options.hint ? { hint: plain(options.hint) } : {}),
    element,
  };
}

// A checkbox group with one option: how an on/off setting is shown.
export function toggle(actionId: string, label: string, checked: boolean) {
  const option = { text: plain(label), value: "enabled" };
  return {
    type: "checkboxes",
    action_id: actionId,
    options: [option],
    initial_options: checked ? [option] : [],
  };
}

export function staticSelect<Option extends { value: string }>(
  actionId: string,
  options: Option[],
  selected: string,
) {
  const initial = options.find((option) => option.value === selected);
  return {
    type: "static_select",
    action_id: actionId,
    options,
    ...(initial ? { initial_option: initial } : {}),
  };
}

// A select over the values of a setting, with an optional description of
// each.
export function modeSelect<Mode extends string>(
  modes: readonly Mode[],
  current: Mode,
  label: (mode: Mode) => string,
  descriptions?: Record<Mode, string>,
) {
  return staticSelect(
    "mode",
    modes.map((mode) => ({
      text: plain(label(mode)),
      value: mode,
      ...(descriptions ? { description: plain(descriptions[mode]) } : {}),
    })),
    current,
  );
}

export function icon(text: string) {
  return { ...plain(text), emoji: true };
}

export function artworkIcon(track?: { artwork?: string; title: string }) {
  if (!track?.artwork) return {};
  return {
    icon: {
      type: "image",
      image_url: track.artwork,
      alt_text: `${track.title} artwork`,
    },
  };
}

export function addedBy(track: { automatic?: boolean; requesterId: string }) {
  return track.automatic
    ? "Autoplay recommendation"
    : `Added by <@${track.requesterId}>`;
}

export function confirm(title: string, text: string, confirmText: string) {
  return {
    title: plain(title),
    text: mrkdwn(text),
    confirm: plain(confirmText),
    deny: plain("Cancel"),
  };
}

export function elapsed(seconds: number) {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return [hours && `${hours}h`, minutes && `${minutes}m`, `${total % 60}s`]
    .filter(Boolean)
    .join(" ");
}

export function songCount(count: number) {
  return `${count} ${count === 1 ? "song" : "songs"}`;
}

export function footerContext(text: string | undefined, blockId: string) {
  const footer = text?.trim();
  return footer ? [context(blockId, footer.slice(0, 3000))] : [];
}

export function sectionBlocks(title: string, lines: string[]) {
  const sections: ReturnType<typeof section>[] = [];
  let text = title;
  for (const line of lines) {
    const value = line.slice(0, 2800);
    if (text.length + value.length > 2900) {
      sections.push(section(text));
      text = "";
    }
    text += `${text ? "\n" : ""}${value}`;
  }
  sections.push(section(text));
  return sections;
}

export function escape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
