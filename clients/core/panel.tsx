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

type Command = { type: string; [key: string]: unknown };

/**
 * What went wrong last, shown at the top of the panel. The bar has nowhere
 * to say it, so it opens the panel to.
 */
const notice = new Store<string | undefined>(undefined);

function say(result: Result) {
  // a message on success says how it went, as "Added 3 of 10 songs"
  if (!result.ok) notice.set(result.message ?? "That didn't work.");
  else if (result.message) notice.set(result.message);
  return result.ok;
}

function can(you: You | undefined, capability: string) {
  return Boolean(you?.capabilities.includes(capability));
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
  return (
    <platform.kit.Tooltip tip={label} delay={300}>
      <button
        type="button"
        className="c-button-unstyled c-audio_player_play_button huddlefm-play"
        aria-label={label}
        aria-pressed={playing}
        onClick={() => run(platform, { type: "toggle" })}
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
  const track = state?.nowPlaying;
  const playing = state?.session.state === "playing";
  const label = track
    ? `${track.title}${track.artist ? ` by ${track.artist}` : ""}`
    : "HuddleFM";
  // a refused command opens the panel, which says why
  const runHere = (command: Command) =>
    run(platform, command).then((ok) => {
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
      className={`${props.className ?? ""} huddlefm-bar`}
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
          <span className="huddlefm-bar__title">
            {track ? track.title : "Nothing playing"}
          </span>
          <span className="huddlefm-bar__artist">
            {track ? track.artist : "Add a song"}
          </span>
        </span>
      </button>
      {track && (
        <>
          <IconButton
            label={playing ? "Pause" : "Play"}
            icon={playing ? "pause-filled" : "play-filled"}
            size="small"
            className="huddlefm-bar__control"
            onClick={() => runHere({ type: "toggle" })}
          />
          <IconButton
            label="Next"
            icon="next-filled"
            size="small"
            className="huddlefm-bar__control"
            onClick={() => runHere({ type: "skip" })}
          />
        </>
      )}
    </div>
  );
}

/** Everything else, for the popover the bar opens. */
export function Panel({ platform }: { platform: Platform }) {
  const { client, kit } = platform;
  const state = client.state.use();
  const you = client.you.use();
  const presence = client.presence.use();
  const problem = notice.use();
  const [view, setView] = React.useState<"main" | "settings" | "end">("main");
  // a new session, or none, starts from the song playing
  const sessionId = state?.session.id;
  React.useEffect(() => setView("main"), [sessionId]);

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
  ) : (
    <>
      <NowPlaying
        platform={platform}
        state={state}
        openSettings={() => setView("settings")}
      />
      <Search platform={platform} you={you} />
      <Queue platform={platform} state={state} you={you} />
    </>
  );

  return (
    <div className="huddlefm-panel">
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
}) {
  const { platform, state } = props;
  const { kit } = platform;
  const track = state.nowPlaying;
  const playing = state.session.state === "playing";

  return (
    <section className="huddlefm-now">
      <div className="huddlefm-now__top">
        <Artwork platform={platform} track={track} size={64} />
        <div className="huddlefm-now__text">
          <div className="huddlefm-now__title">
            {track ? track.title : "Nothing playing"}
          </div>
          <div className="huddlefm-now__artist">
            {track ? track.artist : "Search below to add a song"}
          </div>
          {!track && !state.queue.length && state.session.mode !== "video" && (
            <kit.Button
              type="primary"
              size="small"
              className="huddlefm-now__play-something"
              onClick={() => run(platform, { type: "play_something" })}
            >
              Play something
            </kit.Button>
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
          <span>Nobody is host.</span>
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
        <kit.IconButton
          label="Previous"
          icon="previous-filled"
          onClick={() => run(platform, { type: "previous" })}
        />
        <PlayButton platform={platform} playing={playing} />
        <kit.IconButton
          label="Next"
          icon="next-filled"
          onClick={() => run(platform, { type: "skip" })}
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
          className="huddlefm-progress__slider"
          label={`Seek, ${clock(position)} of ${clock(duration)}`}
          value={position}
          min={0}
          max={duration}
          keyStep={SEEK_STEP}
          onChange={setHeld}
          onCommit={commit}
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
  value: number;
  min: number;
  max: number;
  /** how far an arrow key moves it */
  keyStep: number;
  label: string;
  onChange: (value: number) => void;
  /** when the drag or key press that moved it ends */
  onCommit: () => void;
  className?: string;
}) {
  const { value, min, max, keyStep, onChange, onCommit } = props;
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
  React.useEffect(() => {
    const element = input.current;
    if (!element) return;
    const changed = () => commit.current();
    element.addEventListener("change", changed);
    return () => element.removeEventListener("change", changed);
  }, []);
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const by = steps[event.key];
    if (!by) return;
    event.preventDefault();
    onChange(Math.min(max, Math.max(min, value + by * keyStep)));
  };
  return (
    <input
      type="range"
      className={`huddlefm-slider ${props.className ?? ""}`}
      aria-label={props.label}
      // whole, like the browser keeps it, or React takes its rounding for a
      // move once let go
      value={Math.round(value)}
      min={min}
      max={max}
      step={1}
      style={{ "--huddlefm-fill": `${fill}%` } as React.CSSProperties}
      ref={input}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (steps[event.key]) onCommit();
      }}
    />
  );
}

function Volume({ platform, volume }: { platform: Platform; volume: number }) {
  const [held, setHeld] = React.useState<number | undefined>();
  const value = held ?? volume;
  const commit = () => {
    if (held === undefined) return;
    const percent = held;
    setHeld(undefined);
    if (percent !== volume)
      platform.client.command({ type: "volume", percent }).then(say);
  };
  return (
    <div className="huddlefm-volume">
      <platform.kit.Icon name={value === 0 ? "sound-off" : "sound"} size={16} />
      <Slider
        className="huddlefm-volume__slider"
        label={`Volume, ${Math.round(value)}%`}
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

function Search(props: { platform: Platform; you: You | undefined }) {
  const { platform, you } = props;
  const { client, kit } = platform;
  const allowed = can(you, "add") || can(you, "add-bulk");
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<
    { label: string; reference: string }[]
  >([]);
  const [searching, setSearching] = React.useState(false);
  // what the results shown were searched for
  const [resultsFor, setResultsFor] = React.useState("");
  const latest = React.useRef(0);

  React.useEffect(() => {
    const text = query.trim();
    // any change outdates a search still out
    const ticket = ++latest.current;
    if (!text || isLink(text)) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      client.command({ type: "search", query: text }).then((result) => {
        if (ticket !== latest.current) return;
        setSearching(false);
        if (!say(result)) return;
        setResultsFor(text);
        setResults(
          Array.isArray(result.results)
            ? (result.results as { label: string; reference: string }[])
            : [],
        );
      });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, client]);

  const add = (reference: string) =>
    client.command({ type: "add", reference }).then((result) => {
      if (!say(result)) return;
      setQuery("");
      setResults([]);
    });

  if (!allowed) return null;
  return (
    <section className="huddlefm-search">
      <kit.TextInput
        value={query}
        onChange={setQuery}
        placeholder="Search, or paste a link"
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const text = query.trim();
          if (isLink(text)) add(text);
          else if (results[0] && resultsFor === text) add(results[0].reference);
        }}
      />
      {searching && <kit.Hint>Searching…</kit.Hint>}
      {results.length > 0 && (
        <ul className="huddlefm-results">
          {results.map((result) => (
            <li key={result.reference}>
              <button
                type="button"
                className="c-button-unstyled huddlefm-result"
                onClick={() => add(result.reference)}
              >
                <span className="huddlefm-result__label">{result.label}</span>
                <kit.Icon name="plus" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Queue(props: {
  platform: Platform;
  state: SessionState;
  you: You | undefined;
}) {
  const { platform, state, you } = props;
  const { kit } = platform;
  // a long queue's state carries only its start
  const queued = state.queueLength ?? state.queue.length;
  const manage = can(you, "manage-queue");
  const self = platform.selfUserId();
  const [dragged, setDragged] = React.useState<string | undefined>();
  const [over, setOver] = React.useState<number | undefined>();

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

  const drop = (index: number) => {
    const trackId = dragged;
    setDragged(undefined);
    setOver(undefined);
    if (!trackId) return;
    const from = state.queue.findIndex((track) => track.id === trackId);
    if (from < 0 || from === index) return;
    run(platform, { type: "move", trackId, position: index + 1 });
  };

  return (
    <section className="huddlefm-queue">
      <header className="huddlefm-queue__header">
        <span>
          {queued
            ? `Up next · ${queued}${state.session.queueLimit ? ` of ${state.session.queueLimit}` : ""}`
            : "Nothing queued"}
        </span>
        {state.queue.length > 0 && (
          <span className="huddlefm-queue__actions">
            <kit.IconButton
              label="Shuffle"
              icon="shuffle"
              size="small"
              onClick={() => run(platform, { type: "shuffle" })}
            />
            <kit.IconButton
              label="Clear queue"
              icon="trash"
              size="small"
              onClick={async () => {
                if (
                  await kit.confirm({
                    title: "Clear the queue?",
                    body: `This removes all ${queued} songs waiting to play.`,
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
            ...(track.automatic
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
          return (
            <li
              key={track.id}
              className={`huddlefm-track${over === index ? " huddlefm-track--over" : ""}${dragged === track.id ? " huddlefm-track--dragged" : ""}`}
              draggable={manage}
              onDragStart={(event) => {
                setDragged(track.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (!dragged) return;
                event.preventDefault();
                setOver(index);
              }}
              onDragLeave={() => setOver(undefined)}
              onDrop={(event) => {
                event.preventDefault();
                drop(index);
              }}
              onDragEnd={() => {
                setDragged(undefined);
                setOver(undefined);
              }}
              // plays it now: first in the queue, then skipping to it
              onDoubleClick={(event) => {
                // not the menu's button, or text being selected in it
                if ((event.target as Element).closest("button, [role=menu]"))
                  return;
                playNow(track, index);
              }}
              title="Double-click to play now"
            >
              <Artwork platform={platform} track={track} size={36} />
              <div className="huddlefm-track__text">
                <div className="huddlefm-track__title">{track.title}</div>
                <div className="huddlefm-track__meta">
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

  const shown = groups.filter((group) => group.fields.length);
  const [tab, setTab] = React.useState(shown[0]?.title ?? "You");
  // a tab that's gone, as Host when someone else becomes host, falls back
  const current = shown.some((group) => group.title === tab)
    ? tab
    : (shown[0]?.title ?? "You");
  const fields = (group: (typeof groups)[number]) =>
    group.fields.map((field) => (
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
    ));

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
            onClick={() =>
              platform.openSlackSettings?.().then((opened) => {
                if (!opened)
                  notice.set(
                    "Couldn't open Slack's settings. Use Settings on HuddleFM's message.",
                  );
              })
            }
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
        This stops playback and ends the session.
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
