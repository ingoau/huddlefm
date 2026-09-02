import { safeError } from "./error-message.ts";

export const permissionLabels = {
  add: "Add songs",
  "add-bulk": "Add albums and playlists",
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

export function safeAuditError(error: unknown) {
  return safeError(error);
}

export function plain(text: string) {
  return { type: "plain_text", text: text.slice(0, 150) };
}

export function icon(text: string) {
  return { ...plain(text), emoji: true };
}

export function confirm(title: string, text: string, confirmText: string) {
  return {
    title: plain(title),
    text: { type: "mrkdwn", text },
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
  if (!footer) return [];
  return [
    {
      type: "context",
      block_id: blockId,
      elements: [{ type: "mrkdwn", text: footer.slice(0, 3000) }],
    },
  ];
}

export function sectionBlocks(title: string, lines: string[]) {
  const sections: { type: string; text: { type: string; text: string } }[] = [];
  let text = title;
  for (const line of lines) {
    const value = line.slice(0, 2800);
    if (text.length + value.length > 2900) {
      sections.push({ type: "section", text: { type: "mrkdwn", text } });
      text = "";
    }
    text += `${text ? "\n" : ""}${value}`;
  }
  sections.push({ type: "section", text: { type: "mrkdwn", text } });
  return sections;
}

export function escape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
