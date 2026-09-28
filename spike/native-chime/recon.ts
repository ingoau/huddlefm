// Throwaway spike: join, read JOIN_ACK + INDEX, leave. No media.
import { loadEnv, redact, roomsJoin, Signaling } from "./chime";
import { writeFileSync } from "node:fs";

loadEnv(process.env.SPIKE_ENV ?? new URL("./.env", import.meta.url).pathname);
const channel = process.argv[2] ?? "C0BPVPVLQ4D";

const { meeting, attendee, raw } = await roomsJoin(channel);
console.log(
  "meeting",
  JSON.stringify(
    redact({
      ...meeting,
      MediaPlacement: Object.keys(meeting.MediaPlacement ?? {}),
    }),
    null,
    1,
  ),
);
console.log("attendee keys", Object.keys(attendee));
console.log("huddle participants", raw.huddle?.participants?.length);

const sig = new Signaling(meeting, attendee);
await sig.connect();
console.log("[sig] open");
sig.join();
const ack = await sig.wait("JOIN_ACK");
const turn = ack.joinack?.turn_credentials;
console.log(
  "JOIN_ACK",
  JSON.stringify(
    redact({ ...ack.joinack, turn_credentials: { ...turn, uris: turn?.uris } }),
    null,
    1,
  ),
);
const index = await sig.wait("INDEX").catch((e) => ({ error: String(e) }));
console.log("INDEX", JSON.stringify(index.index ?? index, null, 1));
await Bun.sleep(3000);
sig.send("LEAVE", { leave: {} });
await sig
  .wait("LEAVE_ACK", 5000)
  .then(() => console.log("LEAVE_ACK"))
  .catch((e) => console.log(String(e)));
writeFileSync(
  new URL("./recon-frames.json", import.meta.url).pathname,
  JSON.stringify(redact(sig.log), null, 1),
);
console.log(
  "frames seen",
  [...new Set(sig.log.map((l) => `${l.dir}:${l.type}`))].join(" "),
);
sig.ws.close();
process.exit(0);
