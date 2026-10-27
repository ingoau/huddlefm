// HuddleFM in a huddle's bar: the song playing with play/pause and next, and a
// panel with the rest (the controls, search, the queue and settings). They
// only know the protocol client and the Slack components the mod passes in,
// so any client mod can draw them.

import { clock, isLink } from "./format.ts";
import type { MenuItem, Platform } from "./kit.ts";
import { logoUrl } from "./logo.ts";
import type {
  Result,
  SessionState,
  SettingField,
  Track,
  You,
} from "./protocol.ts";
import { Store } from "./store.ts";

export type { Kit, Platform } from "./kit.ts";

const SEARCH_DELAY_MS = 300;
const NOTICE_MS = 5_000;
/** Seconds a keyboard seek moves by. */
const SEEK_STEP = 5;
/** How long a volume that was taken shows before the bot's state must. */
const VOLUME_WAIT_MS = 3_000;
/** How wide a slider's thumb is, in pixels, as styles.ts draws it. */
const THUMB = 12;

type Command = { type: string; [key: string]: unknown };

/**
 * What went wrong last, shown at the top of the panel. The bar has nowhere
 * to say it, so it opens the panel to.
 */
const notice = new Store<string | undefined>(undefined);

/** Shows what a request was told: why it failed, or how it went. */
export function say(result: Result) {
  // a message on success says how it went, as "Added 3 of 10 songs"
  if (!result.ok) notice.set(result.message ?? "That didn't work.");
  else if (result.message) notice.set(result.message);
  return result.ok;
}

/**
 * Shows the whole of a line of text marked `data-fulltext` that's cut
 * short, as a song title too long for its room, as its tooltip while it's
 * hovered, and none when it all fits.
 */
function useFullText(ref: React.RefObject<HTMLElement | null>) {
  // again after every render, as what the ref holds can change: the bar's
  // song only has it while there's room for the song
  React.useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const over = (event: Event) => {
      const element = (event.target as Element | null)?.closest?.(
        "[data-fulltext]",
      ) as HTMLElement | null;
      if (!element || !root.contains(element)) return;
      const cut =
        element.scrollWidth > element.clientWidth ||
        element.scrollHeight > element.clientHeight;
      element.title = cut ? (element.textContent ?? "") : "";
    };
    root.addEventListener("mouseover", over);
    return () => root.removeEventListener("mouseover", over);
  });
}

function can(you: You | undefined, capability: string) {
  return Boolean(you?.capabilities.includes(capability));
}

/** What each permission lets someone do, to say why a control is off. */
const abilities: Record<string, string> = {
  add: "add songs",
  "add-bulk": "add albums and playlists",
  skip: "skip songs or seek",
  pause: "pause or resume",
  volume: "change the volume",
  "manage-queue": "reorder the queue",
  clear: "clear the queue",
  "end-session": "end the session",
};

/**
 * Whether the user may do what a control does, and if not, why: the
 * control stays, greyed out, so it's clear it's there and who to ask. Until
 * the bot says what they may do, everything is allowed.
 */
function usePermission(platform: Platform, capability: string) {
  const you = platform.client.you.use();
  const state = platform.client.state.use();
  const hostId = state?.session.hostId ?? "";
  const host = platform.useUserName(hostId);
  const self = platform.selfUserId();
  const allowed = !you || can(you, capability);
  const ability = abilities[capability] ?? "do that";
  // the bot only lets those it sees in the huddle use it
  const why = allowed
    ? undefined
    : self && state && !state.participants.includes(self)
      ? "HuddleFM doesn't see you in the huddle yet."
      : hostId && hostId !== self
        ? `Ask ${host} to let you ${ability}.`
        : `You can't ${ability} in this session.`;
  return { allowed, why };
}

/** Runs `command` if allowed, and otherwise says why not. */
function guarded(
  platform: Platform,
  permission: { allowed: boolean; why?: string },
  command: Command,
) {
  if (!permission.allowed) {
    notice.set(permission.why);
    return Promise.resolve(false);
  }
  return run(platform, command);
}

function run(platform: Platform, command: Command) {
  return platform.client.command(command).then(say);
}

function Artwork(props: {
  platform: Platform;
  track: Track | null | undefined;
  size: number;
}) {
  const { track, size } = props;
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [track?.artwork]);
  return track?.artwork && !failed ? (
    <img
      className="huddlefm-artwork"
      src={track.artwork}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      className="huddlefm-artwork huddlefm-artwork--blank"
      style={{ width: size, height: size }}
    >
      <props.platform.kit.Icon name="music" size={Math.round(size / 2)} />
    </span>
  );
}

function AddedBy({ platform, track }: { platform: Platform; track: Track }) {
  const name = platform.useUserName(track.addedBy ?? "");
  if (track.automatic) return <>Autoplay</>;
  if (!track.addedBy) return null;
  return (
    <span className="huddlefm-added">
      <platform.kit.Avatar userId={track.addedBy} size={16} />
      {name}
    </span>
  );
}

/** Play or pause, as Slack's own audio player draws it. */
function PlayButton({
  platform,
  playing,
}: {
  platform: Platform;
  playing: boolean;
}) {
  const label = playing ? "Pause" : "Play";
  const permission = usePermission(platform, "pause");
  return (
    <platform.kit.Tooltip tip={tip(label, permission.why)} delay={300}>
      <button
        type="button"
        className={`c-button-unstyled c-audio_player_play_button huddlefm-play${permission.allowed ? "" : " huddlefm-off"}`}
        aria-label={label}
        aria-pressed={playing}
        aria-disabled={!permission.allowed}
        onClick={() => guarded(platform, permission, { type: "toggle" })}
      >
        <platform.kit.Icon
          name={playing ? "pause-filled" : "play-filled"}
          size={16}
        />
      </button>
    </platform.kit.Tooltip>
  );
}

/**
 * A control's tooltip: what it does, and why it's off when it is. Slack's
 * tooltips show text alone.
 */
function tip(label: string, why?: string) {
  return why ? `${label}: ${why}` : label;
}

/** An icon button that stays when it's not allowed, saying why. */
function Control(props: {
  platform: Platform;
  label: string;
  icon: string;
  capability: string;
  command: Command;
  size?: "small" | "medium";
  className?: string;
  /** what it does instead of running the command */
  onClick?: () => void;
}) {
  const { platform } = props;
  const permission = usePermission(platform, props.capability);
  return (
    <platform.kit.IconButton
      label={props.label}
      tip={tip(props.label, permission.why)}
      icon={props.icon}
      size={props.size}
      className={props.className}
      disabled={!permission.allowed}
      onClick={() => {
        if (!permission.allowed) notice.set(permission.why);
        else if (props.onClick) props.onClick();
        else run(platform, props.command);
      }}
    />
  );
}

/**
 * What a huddle's toolbar shows: the song playing, with play/pause and next,
 * or a music note when nothing's known of HuddleFM yet, or when there's only
 * room for that. Clicking it calls `open`. `className` is the toolbar's own
 * button look, and `onClassName` its look for a button that's on.
 */
export function PlayerBar(props: {
  platform: Platform;
  open: (target: HTMLElement) => void;
  expanded: boolean;
  className?: string;
  onClassName?: string;
  compact?: boolean;
}) {
  const { platform } = props;
  const { Icon, Tooltip, IconButton } = platform.kit;
  const state = platform.client.state.use();
  const ref = React.useRef<HTMLDivElement>(null);
  useFullText(ref);
  const track = state?.nowPlaying;
  const playing = state?.session.state === "playing";
  const pause = usePermission(platform, "pause");
  const skip = usePermission(platform, "skip");
  const label = track
    ? `${track.title}${track.artist ? ` by ${track.artist}` : ""}`
    : "HuddleFM";
  // a refused command opens the panel, which says why
  const runHere = (
    permission: { allowed: boolean; why?: string },
    command: Command,
  ) =>
    guarded(platform, permission, command).then((ok) => {
      if (!ok && ref.current && !props.expanded) props.open(ref.current);
    });

  if (!state || props.compact)
    return (
      <Tooltip tip={state ? label : "HuddleFM"} delay={300}>
        <button
          type="button"
          className={[
            "c-button-unstyled c-icon_button c-icon_button--size_medium c-icon_button--default",
            props.className,
            state && props.onClassName,
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label={state ? `HuddleFM: ${label}` : "HuddleFM"}
          aria-haspopup="dialog"
          aria-expanded={props.expanded}
          onClick={(event) => props.open(event.currentTarget)}
        >
          <Icon name="music" size={20} />
        </button>
      </Tooltip>
    );

  return (
    <div
      ref={ref}
      // on while its popover is open, as the toolbar's own buttons are
      className={[
        props.className,
        props.expanded && props.onClassName,
        "huddlefm-bar",
      ]
        .filter(Boolean)
        .join(" ")}
      // the toolbar's button look is square, and this holds the song too
      style={{ width: "auto" }}
    >
      <button
        type="button"
        className="c-button-unstyled huddlefm-bar__song"
        aria-label={`HuddleFM: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={props.expanded}
        onClick={(event) => props.open(event.currentTarget)}
      >
        <Artwork platform={platform} track={track} size={28} />
        <span className="huddlefm-bar__text">
          <span className="huddlefm-bar__title" data-fulltext>
            {track ? track.title : "Nothing playing"}
          </span>
          <span className="huddlefm-bar__artist" data-fulltext>
            {track ? track.artist : "Add a song"}
          </span>
        </span>
      </button>
      {track && (
        <>
          <IconButton
            label={playing ? "Pause" : "Play"}
            tip={tip(playing ? "Pause" : "Play", pause.why)}
            icon={playing ? "pause-filled" : "play-filled"}
            size="small"
            className="huddlefm-bar__control"
            disabled={!pause.allowed}
            onClick={() => runHere(pause, { type: "toggle" })}
          />
          <IconButton
            label="Next"
            tip={tip("Next", skip.why)}
            icon="next-filled"
            size="small"
            className="huddlefm-bar__control"
            disabled={!skip.allowed}
            onClick={() => runHere(skip, { type: "skip" })}
          />
        </>
      )}
    </div>
  );
}

/** Everything else, for the popover the bar opens. */
export function Panel({ platform }: { platform: Platform }) {
  const { client, kit } = platform;
  const root = React.useRef<HTMLDivElement>(null);
  useFullText(root);
  const state = client.state.use();
  const you = client.you.use();
  const presence = client.presence.use();
  const problem = notice.use();
  const [view, setView] = React.useState<
    "main" | "settings" | "end" | "load" | "discover"
  >("main");
  const [tab, setTab] = React.useState<"queue" | "lyrics">("queue");
  // a new session, or none, starts from the song playing
  const sessionId = state?.session.id;
  React.useEffect(() => setView("main"), [sessionId]);
  // what Add songs offers is for adding songs, in music mode
  const discoverable = state?.session.mode === "music" && can(you, "add");
  React.useEffect(() => {
    if (!discoverable)
      setView((shown) => (shown === "discover" ? "main" : shown));
  }, [discoverable]);
  // lyrics are for a song playing in music mode
  const lyrical = Boolean(
    state?.nowPlaying &&
    !state.nowPlaying.live &&
    state.session.mode === "music",
  );

  React.useEffect(() => {
    if (!problem) return;
    const timer = setTimeout(() => notice.set(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [problem]);

  const body = !state ? (
    <Start platform={platform} presence={presence} />
  ) : view === "settings" ? (
    <Settings
      platform={platform}
      state={state}
      you={you}
      back={() => setView("main")}
      end={() => setView("end")}
    />
  ) : view === "end" ? (
    <EndSession platform={platform} back={() => setView("settings")} />
  ) : view === "load" ? (
    <LoadSave platform={platform} back={() => setView("main")} />
  ) : view === "discover" ? (
    <Discover platform={platform} back={() => setView("main")} />
  ) : (
    <>
      <NowPlaying
        platform={platform}
        state={state}
        openSettings={() => setView("settings")}
        openSaves={() => setView("load")}
      />
      <Search
        platform={platform}
        you={you}
        // as in Slack, video mode has no recommendations or recent songs
        openDiscover={discoverable ? () => setView("discover") : undefined}
      />
      {lyrical ? (
        <kit.Tabs
          label="Up next and lyrics"
          current={tab}
          onChange={(id) => setTab(id === "lyrics" ? "lyrics" : "queue")}
          tabs={[
            {
              id: "queue",
              title: "Up next",
              content: (
                <Queue platform={platform} state={state} you={you} inTab />
              ),
            },
            {
              id: "lyrics",
              title: "Lyrics",
              content: <Lyrics platform={platform} state={state} />,
            },
          ]}
        />
      ) : (
        <Queue platform={platform} state={state} you={you} />
      )}
    </>
  );

  return (
    <div className="huddlefm-panel" ref={root}>
      {problem && <kit.Alert>{problem}</kit.Alert>}
      {body}
    </div>
  );
}

function Start(props: { platform: Platform; presence: string }) {
  const { platform, presence } = props;
  const { kit, huddleFM } = platform;
  const chosen = huddleFM?.useChosen();
  const [users, setUsers] = React.useState<
    { id: string; name: string }[] | undefined
  >();
  const [starting, setStarting] = React.useState(false);
  const [problem, setProblem] = React.useState<string | undefined>();
  const waiting = presence === "waiting";

  // who could be HuddleFM, so there's a choice when it's more than one
  React.useEffect(() => {
    if (!waiting || !huddleFM) return;
    let current = true;
    huddleFM.find().then((found) => {
      if (!current) return;
      setUsers(found);
      if (!chosen && found.length === 1 && found[0])
        huddleFM.choose(found[0].id);
    });
    return () => {
      current = false;
    };
  }, [waiting, huddleFM, chosen]);

  const text =
    presence === "incompatible"
      ? "This HuddleFM needs a newer version of the plugin."
      : presence === "offline"
        ? "Join a huddle to play music in it."
        : "HuddleFM isn't in this huddle.";
  // the chosen user, even when the search doesn't turn it up
  const options = [
    ...(users ?? []),
    ...(chosen && users && !users.some((user) => user.id === chosen)
      ? [{ id: chosen, name: chosen }]
      : []),
  ];
  return (
    <div className="huddlefm-start">
      <img src={logoUrl} alt="" width={56} height={56} />
      <p>{text}</p>
      {problem && <kit.Alert>{problem}</kit.Alert>}
      {waiting && huddleFM && (
        <>
          {options.length > 1 && (
            <div className="huddlefm-start__user">
              <kit.Select
                id="huddlefm-user"
                label="Which HuddleFM"
                options={[
                  ...(chosen ? [] : [{ value: "", label: "Choose HuddleFM…" }]),
                  ...options.map((user) => ({
                    value: user.id,
                    label: user.name,
                  })),
                ]}
                value={chosen ?? ""}
                onChange={(id) => id && huddleFM.choose(id)}
              />
              <kit.Hint>More than one user is named HuddleFM.</kit.Hint>
            </div>
          )}
          {users && !options.length && (
            <kit.Alert>
              Couldn't find a user named HuddleFM. Invite it with the huddle's
              Invite people.
            </kit.Alert>
          )}
          <kit.Button
            type="primary"
            size="small"
            disabled={starting || !chosen}
            onClick={async () => {
              setStarting(true);
              setProblem(undefined);
              const ok = await huddleFM.start();
              setStarting(false);
              if (!ok)
                setProblem(
                  "Couldn't invite HuddleFM. Invite it with the huddle's Invite people.",
                );
            }}
          >
            {starting ? "Starting…" : "Start HuddleFM"}
          </kit.Button>
        </>
      )}
    </div>
  );
}

function NowPlaying(props: {
  platform: Platform;
  state: SessionState;
  openSettings: () => void;
  openSaves: () => void;
}) {
  const { platform, state } = props;
  const { kit } = platform;
  const track = state.nowPlaying;
  const playing = state.session.state === "playing";
  const add = usePermission(platform, "add");
  // music mode's turns on autoplay, a setting
  const playSomething = usePermission(
    platform,
    state.session.mode === "video" ? "add" : "configure-settings",
  );
  // what the player in Slack offers while nothing plays
  const idle = !track && !state.queue.length;

  return (
    <section className="huddlefm-now">
      <div className="huddlefm-now__top">
        <Artwork platform={platform} track={track} size={64} />
        <div className="huddlefm-now__text">
          <div className="huddlefm-now__title" data-fulltext>
            {track ? track.title : "Nothing playing"}
          </div>
          <div className="huddlefm-now__artist" data-fulltext>
            {track
              ? track.artist
              : add.allowed
                ? "Search below to add a song"
                : "Waiting for someone to add a song"}
          </div>
          {idle && add.allowed && (
            <div className="huddlefm-now__start">
              {state.session.mode !== "video" && playSomething.allowed && (
                <kit.Button
                  type="primary"
                  size="small"
                  onClick={() => run(platform, { type: "play_something" })}
                >
                  Play something
                </kit.Button>
              )}
              <kit.Button type="outline" size="small" onClick={props.openSaves}>
                Load a saved session
              </kit.Button>
            </div>
          )}
          {track && (
            <div className="huddlefm-now__meta">
              <AddedBy platform={platform} track={track} />
            </div>
          )}
        </div>
        <kit.IconButton
          label="Settings"
          icon="settings"
          onClick={props.openSettings}
        />
      </div>
      {!state.session.hostId && (
        <div className="huddlefm-host">
          <span>Nobody is host right now.</span>
          <kit.Button
            type="outline"
            size="small"
            onClick={() => run(platform, { type: "claim_host" })}
          >
            Take over
          </kit.Button>
        </div>
      )}
      {track && <Progress platform={platform} track={track} />}
      <div className="huddlefm-controls">
        <Control
          platform={platform}
          label="Previous"
          icon="previous-filled"
          capability="skip"
          command={{ type: "previous" }}
        />
        <PlayButton platform={platform} playing={playing} />
        <Control
          platform={platform}
          label="Next"
          icon="next-filled"
          capability="skip"
          command={{ type: "skip" }}
        />
        <Volume platform={platform} volume={state.session.volume} />
      </div>
    </section>
  );
}

function Progress({ platform, track }: { platform: Platform; track: Track }) {
  const { client } = platform;
  const playing = client.state.use()?.session.state === "playing";
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!playing) return;
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [playing]);
  // where a drag or key press holds the slider, until it lets go
  const [held, setHeld] = React.useState<number | undefined>();
  // without a duration there's nothing to seek along, only the clock
  const known = Boolean(track.duration) && !track.live;
  const duration = Math.max(1, Math.round(track.duration ?? 0));
  const position =
    held ?? (known ? Math.min(duration, client.position()) : client.position());
  const permission = usePermission(platform, "skip");

  const commit = () => {
    if (held === undefined) return;
    const target = Math.min(duration - 1, Math.max(0, held));
    setHeld(undefined);
    client.seek(target).then(say);
  };

  return (
    <div className="huddlefm-progress">
      <span className="huddlefm-progress__time">{clock(position)}</span>
      {!known ? (
        <span className="huddlefm-progress__live">
          {track.live ? "Live" : ""}
        </span>
      ) : (
        <Slider
          platform={platform}
          className="huddlefm-progress__slider"
          label={`Seek, ${clock(position)} of ${clock(duration)}`}
          why={permission.why}
          value={position}
          min={0}
          max={duration}
          keyStep={SEEK_STEP}
          onChange={setHeld}
          onCommit={commit}
          preview={clock}
        />
      )}
      <span className="huddlefm-progress__time">
        {known ? clock(track.duration) : ""}
      </span>
    </div>
  );
}

/**
 * A range input in the look of Slack's media sliders. Slack's own Slider is
 * in a part of Slack that loads only when something else needs it, so it
 * isn't there to borrow.
 */
function Slider(props: {
  platform: Platform;
  value: number;
  min: number;
  max: number;
  /** how far an arrow key moves it */
  keyStep: number;
  label: string;
  /** why it can't be moved, when it can't */
  why?: string;
  onChange: (value: number) => void;
  /** when the drag or key press that moved it ends */
  onCommit: () => void;
  /** what the point under the pointer stands for, shown above it */
  preview?: (value: number) => string;
  className?: string;
}) {
  const { value, min, max, keyStep, onChange, onCommit, why } = props;
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const steps: Record<string, number> = {
    ArrowLeft: -1,
    ArrowDown: -1,
    ArrowRight: 1,
    ArrowUp: 1,
  };
  // React reports only the input moving, so its change, once let go, which
  // ends the drag, is listened to directly
  const input = React.useRef<HTMLInputElement>(null);
  const commit = React.useRef(onCommit);
  commit.current = onCommit;
  // A drag that ends off the slider may never say it changed, so its end is
  // heard from the window too. Each drag is counted, and commits once,
  // whether its change or its release comes first.
  const drag = React.useRef({ count: 0, active: false, committed: 0 });
  const fire = React.useCallback(() => {
    const current = drag.current;
    if (current.count && current.committed === current.count) return;
    current.committed = current.count;
    commit.current();
  }, []);
  React.useEffect(() => {
    const element = input.current;
    const win = element?.ownerDocument.defaultView;
    if (!element || !win) return;
    const changed = () => fire();
    const released = () => {
      if (!drag.current.active) return;
      drag.current.active = false;
      fire();
    };
    element.addEventListener("change", changed);
    win.addEventListener("pointerup", released, true);
    win.addEventListener("pointercancel", released, true);
    return () => {
      element.removeEventListener("change", changed);
      win.removeEventListener("pointerup", released, true);
      win.removeEventListener("pointercancel", released, true);
    };
  }, [fire]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const by = steps[event.key];
    if (!by) return;
    event.preventDefault();
    onChange(Math.min(max, Math.max(min, value + by * keyStep)));
  };
  // the point under the pointer, as a share of the way along
  const [hover, setHover] = React.useState<number | undefined>();
  // The slider doesn't always hear the pointer leave, as after a drag that
  // ends off it, so its window is watched while it shows the time.
  const hovering = hover !== undefined;
  React.useEffect(() => {
    const element = input.current;
    const win = element?.ownerDocument.defaultView;
    if (!hovering || !element || !win) return;
    const away = (event: Event) => {
      if (event.type !== "pointermove" || event.target !== element)
        setHover(undefined);
    };
    win.addEventListener("pointermove", away, true);
    win.addEventListener("blur", away);
    element.ownerDocument.addEventListener("pointerleave", away);
    return () => {
      win.removeEventListener("pointermove", away, true);
      win.removeEventListener("blur", away);
      element.ownerDocument.removeEventListener("pointerleave", away);
    };
  }, [hovering]);
  const point = (event: React.PointerEvent<HTMLInputElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    // the thumb's centre stops half its width from each end
    const share = (event.clientX - box.left - THUMB / 2) / (box.width - THUMB);
    setHover(Math.min(1, Math.max(0, share)));
  };
  const slider = (
    <input
      type="range"
      className="huddlefm-slider"
      aria-label={why ? `${props.label}. ${why}` : props.label}
      // whole, like the browser keeps it, or React takes its rounding for a
      // move once let go
      value={Math.round(value)}
      min={min}
      max={max}
      step={1}
      disabled={Boolean(why)}
      style={{ "--huddlefm-fill": `${fill}%` } as React.CSSProperties}
      ref={input}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (steps[event.key]) onCommit();
      }}
      onPointerDown={() => {
        drag.current.count++;
        drag.current.active = true;
      }}
      onPointerMove={props.preview && !why ? point : undefined}
      onPointerLeave={() => setHover(undefined)}
    />
  );
  return (
    <span className={`huddlefm-slider-wrap ${props.className ?? ""}`}>
      {why ? (
        <props.platform.kit.Tooltip tip={why} delay={300}>
          <span className="huddlefm-off">{slider}</span>
        </props.platform.kit.Tooltip>
      ) : (
        slider
      )}
      {props.preview && hover !== undefined && !why && (
        <span
          className="huddlefm-slider__preview"
          style={{
            // kept within the bar, as the panel would scroll sideways for it
            left: `clamp(24px, calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${hover}), calc(100% - 24px))`,
          }}
          aria-hidden
        >
          {props.preview(min + hover * (max - min))}
        </span>
      )}
    </span>
  );
}

function Volume({ platform, volume }: { platform: Platform; volume: number }) {
  const [held, setHeld] = React.useState<number | undefined>();
  // where it was let go, shown until the bot's state says so too, rather
  // than going back to the old volume meanwhile
  const [sent, setSent] = React.useState<number | undefined>();
  const permission = usePermission(platform, "volume");
  // only the latest change's answer may put it away
  const latest = React.useRef(0);
  // the state has it, so it's no longer only sent
  React.useEffect(() => {
    if (volume === sent) setSent(undefined);
  }, [volume, sent]);
  const value = held ?? sent ?? volume;
  const commit = () => {
    if (held === undefined) return;
    const percent = held;
    setHeld(undefined);
    // against what's shown: dragged back to the old volume before the bot
    // took the last change is a change too
    if (percent === (sent ?? volume)) return;
    const ticket = ++latest.current;
    const settle = () => {
      if (latest.current === ticket) setSent(undefined);
    };
    setSent(percent);
    platform.client.command({ type: "volume", percent }).then((result) => {
      // refused, it's the old volume again
      if (!say(result)) return settle();
      // taken, the state brings it, unless someone else's change comes first
      setTimeout(settle, VOLUME_WAIT_MS);
    });
  };
  return (
    <div className="huddlefm-volume">
      <platform.kit.Icon name={value === 0 ? "sound-off" : "sound"} size={16} />
      <Slider
        platform={platform}
        className="huddlefm-volume__slider"
        label={`Volume, ${Math.round(value)}%`}
        why={permission.why}
        value={value}
        min={0}
        max={100}
        keyStep={5}
        onChange={setHeld}
        onCommit={commit}
      />
    </div>
  );
}

type Found = { label: string; reference: string };
type Suggestion = {
  id: string;
  title: string;
  artist?: string;
  artwork?: string;
  /** the recommendations' group, like Discover */
  group?: string;
};

function Search(props: {
  platform: Platform;
  you: You | undefined;
  /** opens what Add songs offers before anything's typed, when it can */
  openDiscover?: () => void;
}) {
  const { platform, you } = props;
  const { client, kit } = platform;
  const allowed = can(you, "add") || can(you, "add-bulk");
  const permission = usePermission(platform, "add");
  const [query, setQuery] = React.useState("");
  const [source, setSource] = React.useState<"youtube" | "jellyfin">("youtube");
  const [results, setResults] = React.useState<Found[]>([]);
  // what picking a result asked to pick from next, as a show's episodes
  const [choices, setChoices] = React.useState<Found[] | undefined>();
  const [searching, setSearching] = React.useState(false);
  // what the results shown were searched for
  const [resultsFor, setResultsFor] = React.useState("");
  // a pasted link to a Jellyfin server they haven't linked
  const [linkNeeded, setLinkNeeded] = React.useState(false);
  const latest = React.useRef(0);
  const jellyfin = source === "jellyfin" && you?.jellyfin === true;

  React.useEffect(() => {
    const text = query.trim();
    // any change outdates a search still out
    const ticket = ++latest.current;
    setChoices(undefined);
    setLinkNeeded(false);
    if (!text || isLink(text)) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      client
        .command({
          type: "search",
          query: text,
          ...(jellyfin ? { source: "jellyfin" } : {}),
        })
        .then((result) => {
          if (ticket !== latest.current) return;
          setSearching(false);
          if (!say(result)) return;
          setResultsFor(text);
          setResults(
            Array.isArray(result.results) ? (result.results as Found[]) : [],
          );
        });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, client, jellyfin]);

  const done = () => {
    setQuery("");
    setResults([]);
    setChoices(undefined);
  };
  const add = (command: Record<string, unknown>) =>
    client.command({ type: "add", ...command }).then((result) => {
      if (result.linkNeeded) setLinkNeeded(true);
      if (!say(result)) return;
      if (Array.isArray(result.choices)) {
        setChoices(result.choices as Found[]);
        return;
      }
      done();
    });

  if (!allowed)
    return you ? (
      <section className="huddlefm-search">
        <kit.Hint>{permission.why}</kit.Hint>
      </section>
    ) : null;
  const shown = choices ?? results;
  return (
    <section className="huddlefm-search">
      <div className="huddlefm-search__row">
        <kit.TextInput
          value={query}
          onChange={setQuery}
          placeholder={
            jellyfin ? "Search your Jellyfin" : "Search, or paste a link"
          }
          onKeyDown={(event) => {
            if (event.key === "Escape" && (query || choices)) {
              event.stopPropagation();
              done();
              return;
            }
            if (event.key !== "Enter") return;
            const text = query.trim();
            if (isLink(text)) add({ reference: text });
            else if (shown[0] && (choices || resultsFor === text))
              add({ reference: shown[0].reference });
          }}
        />
        {props.openDiscover && (
          <kit.IconButton
            label="Recommendations and recent songs"
            icon={SPARKLE_ICON}
            onClick={props.openDiscover}
          />
        )}
      </div>
      {you?.jellyfin && (
        <div className="huddlefm-sources">
          {(
            [
              ["youtube", "YouTube"],
              ["jellyfin", "Jellyfin"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={source === value}
              aria-label={`Search ${label}`}
              className={`c-button-unstyled huddlefm-source${source === value ? " huddlefm-source--on" : ""}`}
              onClick={() => setSource(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {linkNeeded && platform.openSlackSettings && (
        <div className="huddlefm-search__link">
          <kit.Button
            type="outline"
            size="small"
            onClick={() => openSlack(platform, "you")}
          >
            Link Jellyfin in Slack
          </kit.Button>
        </div>
      )}
      {searching && <kit.Hint>Searching…</kit.Hint>}
      {shown.length > 0 && (
        <ul className="huddlefm-results">
          {choices && (
            <li className="huddlefm-results__heading">Pick one to add</li>
          )}
          {shown.map((result) => (
            <li key={result.reference}>
              <button
                type="button"
                className="c-button-unstyled huddlefm-result"
                onClick={() => add({ reference: result.reference })}
              >
                <span className="huddlefm-result__label" data-fulltext>
                  {result.label}
                </span>
                <kit.Icon name="plus" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Slack's sparkle, as its own features that suggest things wear. */
const SPARKLE_ICON = "sparkles";

type DiscoverTab = "recommended" | "recent" | "discover";

/**
 * What Add songs offers before anything's typed, on a page of its own:
 * songs picked for the user, the ones they added lately, and new ones to
 * try. Adding one keeps the page, for adding more.
 */
function Discover(props: { platform: Platform; back: () => void }) {
  const { platform } = props;
  const { client, kit } = platform;
  const [tab, setTab] = React.useState<DiscoverTab>("recommended");
  const [lists, setLists] = React.useState<
    Record<DiscoverTab, Suggestion[]> | undefined
  >();
  // what's been added from here, and what's on its way, by tab and id
  const [added, setAdded] = React.useState<Set<string>>(new Set());
  const [adding, setAdding] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    let current = true;
    client.command({ type: "suggestions" }).then((result) => {
      if (!current) return;
      if (!say(result)) return props.back();
      const recommended = Array.isArray(result.recommended)
        ? (result.recommended as Suggestion[])
        : [];
      setLists({
        recommended: recommended.filter((item) => item.group !== "Discover"),
        recent: Array.isArray(result.recent)
          ? (result.recent as Suggestion[])
          : [],
        discover: recommended.filter((item) => item.group === "Discover"),
      });
    });
    return () => {
      current = false;
    };
  }, [client]);

  const add = async (kind: DiscoverTab, item: Suggestion) => {
    const key = `${kind}:${item.id}`;
    if (adding.has(key) || added.has(key)) return;
    setAdding((keys) => new Set(keys).add(key));
    const result = await client.command({
      type: "add",
      [kind === "recent" ? "recent" : "recommend"]: item.id,
    });
    setAdding((keys) => {
      const next = new Set(keys);
      next.delete(key);
      return next;
    });
    if (say(result)) setAdded((keys) => new Set(keys).add(key));
  };

  const empty: Record<DiscoverTab, string> = {
    recommended:
      "Nothing to recommend yet. Add some songs, and HuddleFM learns what you like.",
    recent: "Songs you add show up here.",
    discover:
      "Nothing new to try yet. Add some songs, and HuddleFM finds more.",
  };
  const list = (kind: DiscoverTab) => {
    if (!lists) return <kit.Hint>Finding songs…</kit.Hint>;
    const items = lists[kind];
    if (!items.length)
      return <p className="huddlefm-discover__empty">{empty[kind]}</p>;
    return (
      <ul className="huddlefm-discover__list">
        {items.map((item) => {
          const key = `${kind}:${item.id}`;
          const done = added.has(key);
          return (
            <li key={key}>
              <button
                type="button"
                className="c-button-unstyled huddlefm-result"
                disabled={done || adding.has(key)}
                aria-label={`${done ? "Added" : "Add"} ${item.title}${item.artist ? ` by ${item.artist}` : ""}`}
                onClick={() => add(kind, item)}
              >
                <Artwork platform={platform} track={item} size={36} />
                <span className="huddlefm-result__label">
                  <span className="huddlefm-result__title" data-fulltext>
                    {item.title}
                  </span>
                  {item.artist && (
                    <span className="huddlefm-result__artist" data-fulltext>
                      {item.artist}
                    </span>
                  )}
                </span>
                <kit.Icon name={done ? "check" : "plus"} size={16} />
              </button>
            </li>
          );
        })}
      </ul>
    );
  };
  return (
    <section className="huddlefm-discover">
      <header className="huddlefm-settings__header">
        <kit.IconButton label="Back" icon="arrow-left" onClick={props.back} />
        <span>Find something to play</span>
      </header>
      <kit.Tabs
        label="Recommendations and recent songs"
        current={tab}
        onChange={(id) => setTab(id as DiscoverTab)}
        tabs={[
          {
            id: "recommended",
            title: "Recommended",
            content: list("recommended"),
          },
          { id: "recent", title: "Recently added", content: list("recent") },
          { id: "discover", title: "Discover", content: list("discover") },
        ]}
      />
    </section>
  );
}

/** Opens HuddleFM's settings in Slack, saying so if it can't. */
function openSlack(platform: Platform, tab?: "you" | "session" | "host") {
  return platform.openSlackSettings?.(tab).then((opened) => {
    if (!opened)
      notice.set(
        "Couldn't open Slack's settings. Use Settings on HuddleFM's message.",
      );
  });
}

function Queue(props: {
  platform: Platform;
  state: SessionState;
  you: You | undefined;
  /** under a tab that already says Up next */
  inTab?: boolean;
}) {
  const { platform, state, you } = props;
  const { kit } = platform;
  // a long queue's state carries only its start
  const queued = state.queueLength ?? state.queue.length;
  const manage = can(you, "manage-queue");
  const self = platform.selfUserId();
  const [dragged, setDragged] = React.useState<string | undefined>();
  // where a dragged song would go: before this many of the songs shown
  const [gap, setGap] = React.useState<number | undefined>();

  // A song still downloading can't play yet, so skipping would play
  // another; it goes first instead, to play once it's ready.
  const playNow = async (track: Track, index: number) => {
    if (track.status === "failed") {
      notice.set(`${track.title} couldn't be downloaded.`);
      return;
    }
    if (
      index > 0 &&
      !(await run(platform, { type: "move", trackId: track.id, position: 1 }))
    )
      return;
    if (track.status && track.status !== "ready") {
      notice.set(`${track.title} is still downloading, so it plays next.`);
      return;
    }
    run(platform, { type: "skip" });
  };

  // the gap a pointer over a song is nearest: above it, or below it
  const gapAt = (event: React.DragEvent<HTMLElement>, index: number) => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? index : index + 1;
  };
  // the gaps either side of the dragged song leave it where it is
  const from = dragged
    ? state.queue.findIndex((track) => track.id === dragged)
    : -1;
  const shownGap = gap === from || gap === from + 1 ? undefined : gap;
  const drop = () => {
    const trackId = dragged;
    const to = gap;
    setDragged(undefined);
    setGap(undefined);
    if (!trackId || to === undefined) return;
    if (from < 0 || to === from || to === from + 1) return;
    // its place once it's out of the way, counting from 1
    const position = to > from ? to : to + 1;
    run(platform, { type: "move", trackId, position });
  };

  return (
    <section className="huddlefm-queue">
      <header className="huddlefm-queue__header">
        <span>
          {queued
            ? `${props.inTab ? "" : "Up next · "}${queued === 1 ? "1 song" : `${queued} songs`}${state.session.queueLimit ? ` of ${state.session.queueLimit}` : ""}`
            : "Nothing up next"}
        </span>
        {state.queue.length > 0 && (
          <span className="huddlefm-queue__actions">
            <Control
              platform={platform}
              label="Shuffle"
              icon="shuffle"
              size="small"
              capability="manage-queue"
              command={{ type: "shuffle" }}
            />
            <Control
              platform={platform}
              label="Clear queue"
              icon="trash"
              size="small"
              capability="clear"
              command={{ type: "clear" }}
              onClick={async () => {
                if (
                  await kit.confirm({
                    title: "Clear the queue?",
                    body:
                      queued === 1
                        ? "This removes the song waiting to play."
                        : `This removes all ${queued} songs waiting to play.`,
                    confirmText: "Clear",
                    danger: true,
                  })
                )
                  run(platform, { type: "clear" });
              }}
            />
          </span>
        )}
      </header>
      <ol className="huddlefm-queue__list">
        {state.queue.map((track, index) => {
          const last = queued - 1;
          const move = (position: number) => () =>
            run(platform, { type: "move", trackId: track.id, position });
          const moves = manage
            ? [
                index > 0 && { label: "Move to start", onClick: move(1) },
                index > 0 && { label: "Move up", onClick: move(index) },
                index < last && {
                  label: "Move down",
                  onClick: move(index + 2),
                },
                index < last && {
                  label: "Move to end",
                  onClick: move(last + 1),
                },
              ].filter((item) => item !== false)
            : [];
          const removable = manage || track.addedBy === self;
          const first: MenuItem[] = [
            ...(manage && can(you, "skip")
              ? [{ label: "Play now", onClick: () => playNow(track, index) }]
              : []),
            ...(track.automatic && can(you, "add")
              ? [
                  {
                    label: "Add to queue",
                    onClick: () =>
                      run(platform, { type: "keep", trackId: track.id }),
                  },
                ]
              : []),
          ];
          // groups of rows, with a line between each
          const items: MenuItem[] = [first, moves]
            .filter((group) => group.length)
            .flatMap((group, at) =>
              at ? [{ separator: true as const }, ...group] : group,
            );
          if (removable && items.length) items.push({ separator: true });
          items.push(
            ...(removable
              ? [
                  {
                    label: "Remove from queue",
                    danger: true,
                    onClick: () =>
                      run(platform, { type: "remove", trackId: track.id }),
                  },
                ]
              : []),
          );
          const playable = manage && can(you, "skip");
          return (
            <li
              key={track.id}
              className={[
                "huddlefm-track",
                shownGap === index && dragged && "huddlefm-track--gap-above",
                shownGap === index + 1 &&
                  dragged &&
                  index === state.queue.length - 1 &&
                  "huddlefm-track--gap-below",
                dragged === track.id && "huddlefm-track--dragged",
              ]
                .filter(Boolean)
                .join(" ")}
              draggable={manage}
              onDragStart={(event) => {
                setDragged(track.id);
                event.dataTransfer.effectAllowed = "move";
                // Firefox drags only what carries data
                event.dataTransfer.setData("text/plain", track.title);
              }}
              onDragOver={(event) => {
                if (!dragged) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setGap(gapAt(event, index));
              }}
              onDrop={(event) => {
                event.preventDefault();
                drop();
              }}
              onDragEnd={() => {
                setDragged(undefined);
                setGap(undefined);
              }}
              // plays it now: first in the queue, then skipping to it
              onDoubleClick={(event) => {
                // not the menu's button, or text being selected in it
                if (
                  !playable ||
                  (event.target as Element).closest("button, [role=menu]")
                )
                  return;
                playNow(track, index);
              }}
              title={
                [
                  manage && "Drag to reorder",
                  playable && "Double-click to play now",
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
            >
              <Artwork platform={platform} track={track} size={36} />
              <div className="huddlefm-track__text">
                <div className="huddlefm-track__title" data-fulltext>
                  {track.title}
                </div>
                <div className="huddlefm-track__meta" data-fulltext>
                  {track.artist}
                  {track.artist ? " · " : ""}
                  <AddedBy platform={platform} track={track} />
                </div>
              </div>
              <span className="huddlefm-track__time">
                {track.live ? "Live" : clock(track.duration)}
              </span>
              {items.length > 0 && (
                <span className="huddlefm-track__actions">
                  <kit.Menu items={items}>
                    <kit.IconButton
                      label="More actions"
                      icon="ellipsis-vertical-filled"
                      size="small"
                      onClick={() => {}}
                    />
                  </kit.Menu>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Settings(props: {
  platform: Platform;
  state: SessionState;
  you: You | undefined;
  back: () => void;
  end: () => void;
}) {
  const { platform, state, you } = props;
  const { client, kit } = platform;
  const allowed = (field: SettingField) =>
    field.requires === "volume"
      ? can(you, "volume")
      : field.requires === "configure"
        ? can(you, "configure-settings")
        : field.requires === "admin"
          ? Boolean(you?.admin)
          : true;
  const groups: { title: string; fields: SettingField[] }[] = [
    {
      title: "Session",
      fields: state.settings.filter(
        (field) => field.tab === "session" && allowed(field),
      ),
    },
    {
      title: "Host",
      fields: state.settings.filter(
        (field) => field.tab === "host" && allowed(field),
      ),
    },
    { title: "You", fields: you?.settings ?? [] },
  ];
  const change = (field: SettingField, value: unknown) =>
    client
      // the bot takes the volume as a number, though it's picked like a select
      .setting(field.id, {
        value: field.id === "volume" ? Number(value) : value,
      })
      .then(say);

  // Jellyfin's linked in Slack, so it has a place on You whatever else does
  const jellyfin = you?.jellyfin !== undefined && platform.openSlackSettings;
  const shown = groups.filter(
    (group) => group.fields.length || (group.title === "You" && jellyfin),
  );
  const [tab, setTab] = React.useState(shown[0]?.title ?? "You");
  // a tab that's gone, as Host when someone else becomes host, falls back
  const current = shown.some((group) => group.title === tab)
    ? tab
    : (shown[0]?.title ?? "You");
  const fields = (group: (typeof groups)[number]) => [
    ...group.fields.map((field) => (
      <React.Fragment key={field.id}>
        {field.section && (
          <h4 className="huddlefm-settings__section">{field.section}</h4>
        )}
        <Field
          field={field}
          platform={platform}
          participants={state.participants.filter(
            (id) => id !== client.botUserId,
          )}
          onChange={(value) => change(field, value)}
          onPreset={(preset) => client.setting(field.id, { preset }).then(say)}
        />
      </React.Fragment>
    )),
    group.title === "You" && jellyfin && (
      <div key="jellyfin" className="huddlefm-field">
        <div className="huddlefm-field__label">Jellyfin</div>
        <div>
          <kit.Button
            type="outline"
            size="small"
            onClick={() => openSlack(platform, "you")}
          >
            {you?.jellyfin
              ? "Manage Jellyfin in Slack"
              : "Link Jellyfin in Slack"}
          </kit.Button>
        </div>
        <kit.Hint>
          {you?.jellyfin
            ? "Search it from the search box, under Jellyfin."
            : "Play from your own Jellyfin server. Linking shows a code to approve, so it happens in Slack, where only you see it."}
        </kit.Hint>
      </div>
    ),
  ];

  return (
    <section className="huddlefm-settings">
      <header className="huddlefm-settings__header">
        <kit.IconButton label="Back" icon="arrow-left" onClick={props.back} />
        <span>Settings</span>
      </header>
      {shown.length > 1 ? (
        <kit.Tabs
          label="HuddleFM settings"
          current={current}
          onChange={setTab}
          tabs={shown.map((group) => ({
            id: group.title,
            title: group.title,
            content: (
              <div className="huddlefm-settings__tab">{fields(group)}</div>
            ),
          }))}
        />
      ) : (
        shown.map((group) => (
          <div key={group.title} className="huddlefm-settings__tab">
            {fields(group)}
          </div>
        ))
      )}
      <div className="huddlefm-settings__footer">
        {platform.openSlackSettings && (
          <kit.Button
            type="outline"
            size="small"
            onClick={() => openSlack(platform, "you")}
          >
            Accounts and more in Slack
          </kit.Button>
        )}
        {can(you, "end-session") && (
          <kit.Button type="danger" size="small" onClick={props.end}>
            End session
          </kit.Button>
        )}
      </div>
    </section>
  );
}

/**
 * Ending, as End session's dialog in Slack asks it: whether to save the
 * queue and settings for a later session, to this channel or the user's
 * account.
 */
function EndSession(props: { platform: Platform; back: () => void }) {
  const { platform } = props;
  const { kit } = platform;
  const [save, setSave] = React.useState("none");
  const [name, setName] = React.useState("");
  const options = [
    { value: "none", label: "Don't save" },
    { value: "channel", label: "Save to this channel" },
    { value: "user", label: "Save to my account" },
  ];
  return (
    <section className="huddlefm-end">
      <header className="huddlefm-settings__header">
        <kit.IconButton label="Back" icon="arrow-left" onClick={props.back} />
        <span>End session?</span>
      </header>
      <p className="huddlefm-end__text">
        This stops the music and ends the session for everyone.
      </p>
      <div className="huddlefm-field">
        <div className="huddlefm-field__label">Save for next time</div>
        <kit.Select
          id="huddlefm-end-save"
          label="Save for next time"
          options={options}
          value={save}
          onChange={setSave}
        />
        <kit.Hint>
          Saves the queue and settings, not permissions. Anyone here can load a
          channel save; only you can load one in your account.
        </kit.Hint>
      </div>
      {save !== "none" && (
        <div className="huddlefm-field">
          <div className="huddlefm-field__label">Name</div>
          <kit.TextInput
            value={name}
            onChange={setName}
            placeholder="Named for its first song, if left empty"
          />
          <kit.Hint>
            Saving under a name you have used before replaces that save.
          </kit.Hint>
        </div>
      )}
      <div className="huddlefm-settings__footer">
        <kit.Button type="outline" size="small" onClick={props.back}>
          Cancel
        </kit.Button>
        <kit.Button
          type="danger"
          size="small"
          onClick={() =>
            run(platform, {
              type: "end",
              save,
              ...(save !== "none" && name.trim() ? { name: name.trim() } : {}),
            })
          }
        >
          End session
        </kit.Button>
      </div>
    </section>
  );
}

type Save = {
  id: string;
  name: string;
  owner: "channel" | "user";
  songs: number;
  savedAt: number;
  /** whether they may delete it */
  deletable: boolean;
};

/**
 * Load saved session, as the idle player in Slack offers it: a save from this
 * channel or the user's account, its queue added and its settings applied.
 */
function LoadSave(props: { platform: Platform; back: () => void }) {
  const { platform } = props;
  const { client, kit } = platform;
  const [saves, setSaves] = React.useState<Save[] | undefined>();
  const [chosen, setChosen] = React.useState<string | undefined>();
  const [forget, setForget] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  // a second click, or a double-click on another save, while one loads
  const busy = React.useRef(false);
  React.useEffect(() => {
    let current = true;
    client.command({ type: "saves" }).then((result) => {
      if (!current) return;
      if (!say(result)) return props.back();
      const found = Array.isArray(result.saves) ? (result.saves as Save[]) : [];
      setSaves(found);
      setChosen(found[0]?.id);
    });
    return () => {
      current = false;
    };
  }, [client]);
  const save = saves?.find((item) => item.id === chosen);
  const groups = (
    [
      ["This channel", "channel"],
      ["Your account", "user"],
    ] as const
  )
    .map(([title, owner]) => ({
      title,
      items: (saves ?? []).filter((item) => item.owner === owner),
    }))
    .filter((group) => group.items.length);
  const load = async (chosen = save) => {
    if (!chosen || busy.current) return;
    busy.current = true;
    setLoading(true);
    const ok = await run(platform, {
      type: "load",
      saveId: chosen.id,
      forget: forget && chosen.deletable,
    });
    busy.current = false;
    setLoading(false);
    if (ok) props.back();
  };
  return (
    <section className="huddlefm-load">
      <header className="huddlefm-settings__header">
        <kit.IconButton label="Back" icon="arrow-left" onClick={props.back} />
        <span>Load a saved session</span>
      </header>
      {!saves ? (
        <kit.Hint>Finding saved sessions…</kit.Hint>
      ) : !saves.length ? (
        <p className="huddlefm-end__text">
          There are no saved sessions to load. Save one when you end a session.
        </p>
      ) : (
        <>
          {groups.map((group) => (
            <div key={group.title}>
              <h4 className="huddlefm-settings__section">{group.title}</h4>
              <ul className="huddlefm-saves">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-pressed={item.id === chosen}
                      className={`c-button-unstyled huddlefm-save${item.id === chosen ? " huddlefm-save--on" : ""}`}
                      onClick={() => setChosen(item.id)}
                      onDoubleClick={() => {
                        setChosen(item.id);
                        load(item);
                      }}
                    >
                      <span className="huddlefm-save__name" data-fulltext>
                        {item.name}
                      </span>
                      <span className="huddlefm-save__meta">
                        {item.songs === 1 ? "1 song" : `${item.songs} songs`}
                        {" · "}
                        {savedWhen(item.savedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <kit.Hint>
            Adds its songs to the queue and applies its settings.
          </kit.Hint>
          {save?.deletable && (
            <kit.Checkbox
              checked={forget}
              onChange={setForget}
              label="Delete it after loading"
            />
          )}
          <div className="huddlefm-settings__footer">
            <kit.Button type="outline" size="small" onClick={props.back}>
              Cancel
            </kit.Button>
            <kit.Button
              type="primary"
              size="small"
              disabled={!save || loading}
              onClick={() => load()}
            >
              {loading ? "Loading…" : "Load"}
            </kit.Button>
          </div>
        </>
      )}
    </section>
  );
}

/** When something was saved, as a date, or a time today. */
function savedWhen(at: number) {
  const date = new Date(at);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? `today at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        ...(date.getFullYear() === today.getFullYear()
          ? {}
          : { year: "numeric" }),
      });
}

type LyricLine = {
  start: number;
  end: number;
  text: string;
  instrumental?: boolean;
};
type LyricsAnswer = { lines: LyricLine[]; synced: boolean } | "none";

/** The lyrics asked for, by song, so switching tabs doesn't ask again. */
const lyricsCache = new Map<string, LyricsAnswer>();

/**
 * The playing song's lyrics, as the video card has them: the line being sung
 * lit and kept in view, and a click on a line jumping there.
 */
function Lyrics(props: { platform: Platform; state: SessionState }) {
  const { platform, state } = props;
  const { client, kit } = platform;
  const trackId = state.nowPlaying?.id;
  const [lyrics, setLyrics] = React.useState<LyricsAnswer | undefined>(
    trackId ? lyricsCache.get(trackId) : undefined,
  );
  const permission = usePermission(platform, "skip");
  React.useEffect(() => {
    if (!trackId) return;
    const known = lyricsCache.get(trackId);
    setLyrics(known);
    if (known) return;
    let current = true;
    client.command({ type: "lyrics", trackId }).then((result) => {
      if (!result.ok) {
        if (current) setLyrics("none");
        return;
      }
      const lines = Array.isArray(result.lines)
        ? (result.lines as LyricLine[])
        : [];
      const answer: LyricsAnswer = lines.length
        ? { lines, synced: result.synced === true }
        : "none";
      // only a song's own answer is kept, not a failure to ask
      lyricsCache.set(trackId, answer);
      const oldest = lyricsCache.keys().next().value;
      if (lyricsCache.size > 20 && oldest) lyricsCache.delete(oldest);
      if (current) setLyrics(answer);
    });
    return () => {
      current = false;
    };
  }, [trackId, client]);

  const playing = state.session.state === "playing";
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  const synced = lyrics !== "none" && lyrics?.synced;
  React.useEffect(() => {
    if (!playing || !synced) return;
    const timer = setInterval(tick, 200);
    return () => clearInterval(timer);
  }, [playing, synced]);
  const at = client.position() * 1000;
  const lines = lyrics === "none" ? [] : (lyrics?.lines ?? []);
  let active = -1;
  if (synced)
    for (let index = 0; index < lines.length; index++)
      if ((lines[index]?.start ?? Infinity) <= at) active = index;

  // the line being sung kept in the middle, unless they've scrolled away
  const box = React.useRef<HTMLDivElement>(null);
  const scrolledAt = React.useRef(0);
  React.useEffect(() => {
    const container = box.current;
    const line = container?.querySelector<HTMLElement>(
      ".huddlefm-lyric--active",
    );
    if (!container || !line) return;
    if (performance.now() - scrolledAt.current < 3_000) return;
    container.scrollTo({
      top: line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2,
      behavior: "smooth",
    });
  }, [active]);

  if (!lyrics) return <kit.Hint>Finding lyrics…</kit.Hint>;
  if (lyrics === "none")
    return (
      <p className="huddlefm-lyrics__none">
        There are no lyrics for this song.
      </p>
    );
  return (
    <div
      ref={box}
      className={`huddlefm-lyrics${synced ? "" : " huddlefm-lyrics--plain"}`}
      onWheel={() => {
        scrolledAt.current = performance.now();
      }}
    >
      {lines.map((line, index) => {
        const text = line.instrumental || !line.text.trim() ? "♪" : line.text;
        const className = [
          "huddlefm-lyric",
          index === active && "huddlefm-lyric--active",
          index < active && "huddlefm-lyric--past",
        ]
          .filter(Boolean)
          .join(" ");
        return synced && permission.allowed ? (
          <button
            // lines repeat, so they're told apart by where they are
            key={`${line.start}:${index}`}
            type="button"
            className={`c-button-unstyled ${className}`}
            onClick={() => {
              scrolledAt.current = 0;
              client.seek(line.start / 1000).then(say);
            }}
          >
            {text}
          </button>
        ) : (
          <p key={`${line.start}:${index}`} className={className}>
            {text}
          </p>
        );
      })}
    </div>
  );
}

/**
 * Checkboxes that send their whole list. Ticks build on those not yet back
 * in the bot's state, so ticking two quickly keeps both.
 */
function MultiField(props: {
  field: Extract<SettingField, { kind: "multi" }>;
  kit: Platform["kit"];
  label: React.ReactNode;
  hint: React.ReactNode;
  /** resolves whether the bot took it */
  onChange: (value: unknown) => Promise<boolean>;
  onPreset: (preset: string) => void;
}) {
  const { field, kit } = props;
  const [ticked, setTicked] = React.useState(field.value);
  // the bot's word replaces what was ticked, once it comes
  const confirmed = field.value.join("\n");
  React.useEffect(() => setTicked(field.value), [confirmed]);
  const toggle = (value: string, on: boolean) => {
    const next = field.options
      .map((option) => option.value)
      .filter((option) => (option === value ? on : ticked.includes(option)));
    setTicked(next);
    props.onChange(next).then((ok) => {
      if (!ok) setTicked(field.value);
    });
  };
  return (
    <div className="huddlefm-field">
      {props.label}
      {field.presets && (
        <div className="huddlefm-presets">
          {field.presets.map((preset) => (
            <kit.Button
              key={preset.value}
              type="outline"
              size="small"
              onClick={() => props.onPreset(preset.value)}
            >
              {preset.label}
            </kit.Button>
          ))}
        </div>
      )}
      {field.options.map((option) => (
        <kit.Checkbox
          key={option.value}
          checked={ticked.includes(option.value)}
          onChange={(checked) => toggle(option.value, checked)}
          label={option.label}
        />
      ))}
      {props.hint}
    </div>
  );
}

function Field(props: {
  field: SettingField;
  platform: Platform;
  participants: string[];
  /** resolves whether the bot took it */
  onChange: (value: unknown) => Promise<boolean>;
  onPreset: (preset: string) => void;
}) {
  const { field, platform } = props;
  const { kit } = platform;
  const label = <div className="huddlefm-field__label">{field.label}</div>;
  // under the control, as Slack's forms put it
  const hint = (text?: string) => {
    const shown = text ?? field.hint;
    return shown ? <kit.Hint>{shown}</kit.Hint> : null;
  };
  switch (field.kind) {
    case "select": {
      const current = field.options.find(
        (option) => option.value === field.value,
      );
      return (
        <div className="huddlefm-field">
          {label}
          <kit.Select
            id={`huddlefm-${field.id}`}
            label={field.label}
            options={field.options.map(({ value, label }) => ({
              value,
              label,
            }))}
            value={field.value}
            onChange={(value) => props.onChange(value)}
          />
          {hint(current?.description)}
        </div>
      );
    }
    case "toggle":
      return (
        <div className="huddlefm-field">
          {label}
          <kit.Checkbox
            checked={field.value}
            onChange={(checked) => props.onChange(checked)}
            label={field.text}
          />
          {hint()}
        </div>
      );
    case "multi":
      return (
        <MultiField
          field={field}
          kit={kit}
          label={label}
          hint={hint()}
          onChange={props.onChange}
          onPreset={props.onPreset}
        />
      );
    case "user":
      return (
        <div className="huddlefm-field">
          {label}
          <UserSelect
            platform={platform}
            id={`huddlefm-${field.id}`}
            participants={props.participants}
            value={field.value}
            onChange={(value) => props.onChange(value)}
          />
          {hint()}
        </div>
      );
  }
}

// One component per participant, so each name is read with a hook of its own.
function UserName(props: {
  platform: Platform;
  id: string;
  report: (id: string, name: string) => void;
}) {
  const name = props.platform.useUserName(props.id);
  const { report, id } = props;
  React.useEffect(() => report(id, name), [report, id, name]);
  return null;
}

function UserSelect(props: {
  platform: Platform;
  id: string;
  participants: string[];
  value: string | null;
  onChange: (value: string) => void;
}) {
  const [names, setNames] = React.useState<Record<string, string>>({});
  const report = React.useCallback(
    (id: string, name: string) =>
      setNames((known) =>
        known[id] === name ? known : { ...known, [id]: name },
      ),
    [],
  );
  return (
    <>
      {props.participants.map((id) => (
        <UserName key={id} platform={props.platform} id={id} report={report} />
      ))}
      <props.platform.kit.Select
        id={props.id}
        label="Host"
        options={props.participants.map((id) => ({
          value: id,
          label: names[id] ?? id,
        }))}
        value={props.value ?? undefined}
        onChange={props.onChange}
      />
    </>
  );
}
