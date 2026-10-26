import { expect, test } from "bun:test";
import {
  decoderArgs,
  playerFilter,
  VideoPlayer,
  type FrameDecoder,
} from "./video-player.ts";

/** A decoder whose frames are numbered buffers, decoded as fast as asked. */
class FakeDecoder implements FrameDecoder {
  frames: { index: number; data: Buffer }[] = [];
  decoded = -1;
  finished = false;
  error: string | undefined;
  closed = false;

  constructor(
    readonly start: number,
    readonly subtitles: string | undefined,
  ) {}

  decode(count: number) {
    for (let index = 0; index < count; index++) {
      this.decoded++;
      this.frames.push({
        index: this.decoded,
        data: Buffer.from(`${this.start}:${this.decoded}`),
      });
    }
  }

  recycled: Buffer[] = [];
  recycle(data: Buffer) {
    this.recycled.push(data);
  }

  close() {
    this.closed = true;
  }
}

function player() {
  const decoders: FakeDecoder[] = [];
  const errors: string[] = [];
  const video = new VideoPlayer(
    { width: 1280, height: 720, fps: 10 },
    (error) => errors.push(error),
    (_url, start, subtitles) => {
      const decoder = new FakeDecoder(start, subtitles);
      decoders.push(decoder);
      return decoder;
    },
  );
  return { video, decoders, errors };
}

const shown = (frame: Buffer | undefined) => frame?.toString();

test("shows the frame for where the audio is, holding the last until the next is decoded", () => {
  const { video, decoders } = player();
  video.setSource({ key: 1, url: "clip.mkv", subtitles: "clip.srt" });
  expect(video.frame(0, 1)).toBeUndefined();
  expect(decoders).toHaveLength(1);
  expect(decoders[0]!.start).toBe(0);
  // Captions are off, so the decoder has none.
  expect(decoders[0]!.subtitles).toBeUndefined();
  decoders[0]!.decode(5);
  expect(shown(video.frame(0.25, 1))).toBe("0:2");
  expect(video.ready).toBeTrue();
  // Paused: the same buffer again, so the encoder can skip it.
  expect(video.frame(0.25, 1)).toBe(video.frame(0.25, 1));
  // Ahead of the decoder: the last frame stays up.
  expect(shown(video.frame(0.9, 1))).toBe("0:4");
  decoders[0]!.decode(5);
  expect(shown(video.frame(0.9, 1))).toBe("0:9");
  expect(decoders).toHaveLength(1);
});

test("follows a seek by starting the decoder there", () => {
  const { video, decoders } = player();
  video.setSource({ key: 1, url: "clip.mkv" });
  video.frame(0, 1);
  decoders[0]!.decode(20);
  expect(shown(video.frame(1, 1))).toBe("0:10");
  // Forward, well past what is decoded.
  video.frame(30, 1);
  expect(decoders).toHaveLength(2);
  expect(decoders[0]!.closed).toBeTrue();
  expect(decoders[1]!.start).toBe(30);
  decoders[1]!.decode(3);
  expect(shown(video.frame(30.15, 1))).toBe("30:1");
  // Back more than a second.
  video.frame(10, 1);
  expect(decoders).toHaveLength(3);
  expect(decoders[2]!.start).toBe(10);
});

test("waits for its own entry's clock", () => {
  const { video, decoders } = player();
  video.setSource({ key: 2, url: "clip.mkv" });
  expect(video.frame(5, 1)).toBeUndefined();
  expect(video.frame(undefined, 2)).toBeUndefined();
  expect(decoders).toHaveLength(0);
});

test("burns in captions by starting again where it was", () => {
  const { video, decoders } = player();
  video.setSource({ key: 1, url: "clip.mkv", subtitles: "clip.srt" });
  video.frame(12, 1);
  video.setCaptions(true);
  expect(decoders).toHaveLength(2);
  expect(decoders[1]!.subtitles).toBe("clip.srt");
  expect(decoders[1]!.start).toBe(12);
  video.setCaptions(false);
  expect(decoders[2]!.subtitles).toBeUndefined();
});

test("gives up on a video that will not decode, so the card shows", () => {
  const { video, decoders, errors } = player();
  video.setSource({ key: 1, url: "broken.mkv" });
  video.frame(0, 1);
  decoders[0]!.error = "Invalid data";
  expect(video.frame(0.1, 1)).toBeUndefined();
  expect(errors).toEqual(["Invalid data"]);
  expect(video.ready).toBeFalse();
  // Not tried again for the same entry.
  expect(video.frame(0.2, 1)).toBeUndefined();
  expect(decoders).toHaveLength(1);
  // A new entry starts afresh.
  video.setSource({ key: 2, url: "next.mkv" });
  video.frame(0, 2);
  expect(decoders).toHaveLength(2);
});

test("lets the decoder go when the share stops, and starts it again after", () => {
  const { video, decoders } = player();
  video.setSource({ key: 1, url: "clip.mkv" });
  video.frame(3, 1);
  decoders[0]!.decode(2);
  video.release();
  expect(decoders[0]!.closed).toBeTrue();
  expect(video.ready).toBeFalse();
  video.frame(4, 1);
  expect(decoders).toHaveLength(2);
  expect(decoders[1]!.start).toBe(4);
});

test("decodes on the audio's timeline so captions line up after a seek", () => {
  expect(
    playerFilter({ width: 1280, height: 720, fps: 30 }, 5, "/data/a.srt"),
  ).toBe(
    "setpts=PTS+5.000/TB,fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,subtitles=filename='/data/a.srt':force_style='FontName=Noto Sans,Fontsize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H59000000,BackColour=&H59000000,BorderStyle=3,Outline=2,Shadow=0,Alignment=2,MarginV=14',setpts=PTS-STARTPTS,format=yuv420p",
  );
  // A path the filter graph could misread is left out rather than escaped.
  expect(
    playerFilter({ width: 1280, height: 720, fps: 30 }, 0, "/data/it's.srt"),
  ).not.toContain("subtitles");
  expect(
    decoderArgs("clip.mkv", { width: 1280, height: 720, fps: 30 }, 0),
  ).toContain("passthrough");
});

test("hands the frames it has passed back to the decoder, never the one up", () => {
  const { video, decoders } = player();
  video.setSource({ key: 1, url: "clip.mkv" });
  video.frame(0, 1);
  decoders[0]!.decode(10);
  const first = video.frame(0, 1);
  expect(decoders[0]!.recycled).toEqual([]);
  const later = video.frame(0.5, 1);
  expect(shown(later)).toBe("0:5");
  // The first frame, and those skipped over on the way to the sixth.
  expect(decoders[0]!.recycled.map(shown)).toEqual([
    "0:0",
    "0:1",
    "0:2",
    "0:3",
    "0:4",
  ]);
  expect(decoders[0]!.recycled[0]).toBe(first!);
  expect(decoders[0]!.recycled).not.toContain(later!);
});

const hasFfmpeg = Boolean(Bun.which("ffmpeg"));

test.skipIf(!hasFfmpeg)(
  "decodes a real video with ffmpeg in step with the clock",
  async () => {
    const directory = `${process.env.TMPDIR ?? "/tmp"}/huddlefm-player-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${directory}`.quiet();
    const clip = `${directory}/clip.mp4`;
    await Bun.$`ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=320x180:rate=25 -t 3 -pix_fmt yuv420p ${clip}`.quiet();
    const errors: string[] = [];
    const video = new VideoPlayer(
      { width: 320, height: 180, fps: 10 },
      (error) => errors.push(error),
    );
    try {
      video.setSource({ key: 1, url: clip });
      let frame: Buffer | undefined;
      for (let attempt = 0; attempt < 200 && !frame; attempt++) {
        frame = video.frame(1, 1);
        await Bun.sleep(10);
      }
      expect(frame?.length).toBe((320 * 180 * 3) / 2);
      expect(errors).toEqual([]);
      // Played through, frame after frame: each is a Buffer of its own, in
      // memory used again once a frame has been shown.
      const frames = new Set<Buffer>();
      const memory = new Set<ArrayBufferLike>();
      for (let position = 1; position < 2.9; position += 0.1) {
        await Bun.sleep(20);
        const next = video.frame(position, 1)!;
        frames.add(next);
        memory.add(next.buffer);
      }
      expect(frames.size).toBeGreaterThan(15);
      expect(memory.size).toBeLessThan(frames.size);
      expect(errors).toEqual([]);
    } finally {
      video.stop();
      await Bun.$`rm -rf ${directory}`.quiet();
    }
  },
  10_000,
);

/** A live decoder, which knows where its stream's timestamps start. */
class LiveDecoder extends FakeDecoder {
  streamStart: number | undefined;
}

test("lines a live stream's picture up with its sound by where each joined", () => {
  const decoders: LiveDecoder[] = [];
  const video = new VideoPlayer(
    { width: 1280, height: 720, fps: 10 },
    () => {},
    (_url, start, subtitles, input) => {
      expect(input).toEqual({ live: true });
      const decoder = new LiveDecoder(start, subtitles);
      decoders.push(decoder);
      return decoder;
    },
  );
  video.setSource({ key: 1, url: "live.m3u8", input: { live: true } });
  expect(video.frame(0, 1, 100)).toBeUndefined();
  decoders[0]!.decode(30);
  // Not lined up until the picture's start is known.
  expect(video.frame(0.5, 1, 100)).toBeUndefined();
  // The picture joined a second before the sound, so it is 1 s further in.
  decoders[0]!.streamStart = 99;
  expect(shown(video.frame(0.5, 1, 100))).toBe("0:15");
  // Far ahead: frames are dropped to catch up, never a seek.
  expect(shown(video.frame(2.9, 1, 100))).toBe("0:29");
  expect(decoders).toHaveLength(1);
  // The sound joined again after a pause; so does the picture.
  video.frame(0.1, 1, 200);
  expect(decoders).toHaveLength(2);
  expect(decoders[0]!.closed).toBeTrue();
});
