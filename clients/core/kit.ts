// The Slack components the panel draws with, which each client mod hands in
// from its own way of reaching them.

import type { HuddleFMClient } from "./protocol.ts";

type Children = { children?: React.ReactNode };

/** A row of a menu, or a line between rows. */
export type MenuItem =
  | { label: string; danger?: boolean; onClick: () => void }
  | { separator: true };

export type Kit = {
  /** one of Slack's icons, by its name, like `play-filled` */
  Icon: React.ComponentType<{ name: string; size?: number }>;
  Button: React.ComponentType<
    Children & {
      type?: "primary" | "ghost" | "outline" | "danger";
      size?: "small" | "medium" | "large";
      onClick?: () => void;
      disabled?: boolean;
      className?: string;
    }
  >;
  /** Slack's icon button with its tooltip */
  IconButton: React.ComponentType<{
    label: string;
    icon: string;
    onClick: () => void;
    size?: "small" | "medium";
    className?: string;
  }>;
  Tooltip: React.ComponentType<
    Children & { tip: React.ReactNode; position?: string; delay?: number }
  >;
  Select: React.ComponentType<{
    id: string;
    options: { label: string; value: string }[];
    value?: string;
    onChange: (value: string) => void;
    label?: string;
    disabled?: boolean;
  }>;
  Checkbox: React.ComponentType<{
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: React.ReactNode;
    disabled?: boolean;
  }>;
  TextInput: React.ComponentType<{
    value: string;
    onChange: (value: string) => void;
    onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    placeholder?: string;
    autoFocus?: boolean;
  }>;
  /** Slack's menu, opened from `children` */
  Menu: React.ComponentType<Children & { items: MenuItem[] }>;
  Avatar: React.ComponentType<{ userId: string; size: number }>;
  /** Slack's tabs, drawing the current one's content */
  Tabs: React.ComponentType<{
    label: string;
    tabs: { id: string; title: string; content: React.ReactNode }[];
    current: string;
    onChange: (id: string) => void;
  }>;
  Hint: React.ComponentType<Children>;
  /** Slack's inline error */
  Alert: React.ComponentType<Children>;
  /** asks in Slack's confirmation dialog, resolving whether they confirmed */
  confirm(options: {
    title: string;
    body?: string;
    confirmText: string;
    danger?: boolean;
  }): Promise<boolean>;
};

/** What the panel needs from the client mod it runs in. */
export type Platform = {
  client: HuddleFMClient;
  kit: Kit;
  /** the Slack user the mod runs as */
  selfUserId(): string | undefined;
  /** a Slack user's name, read reactively */
  useUserName(userId: string): string;
  /** opens Slack's own HuddleFM settings, when the mod can */
  openSlackSettings?(): Promise<boolean>;
  /** inviting HuddleFM to the huddle, when the mod can */
  huddleFM?: {
    /** the user Start HuddleFM invites, read reactively */
    useChosen(): string | undefined;
    /** the workspace's users whose name has HuddleFM in it */
    find(): Promise<{ id: string; name: string }[]>;
    choose(userId: string): void;
    /** invites the chosen user to the huddle you're in */
    start(): Promise<boolean>;
  };
};
