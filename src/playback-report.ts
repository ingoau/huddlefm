import { input, plain, section } from "./coordinator-ui.ts";
import type { Interaction } from "./slack-app.ts";

export const playbackProblems = {
  no_sound: "No sound",
  choppy_sound: "Choppy, robotic, or distorted sound",
  video: "Video missing or looks wrong",
  lyrics: "Lyrics missing or out of sync",
  other: "Other",
} as const;

export type PlaybackProblem = keyof typeof playbackProblems;

/** The report modal's callback ID; the player button is `report_playback_problem`. */
export const playbackReportCallbackId = "playback_problem_report";

const detailsMaxLength = 1_000;

type ReportMetadata = {
  sessionId: string;
  reportId: string;
  /** Whether pressing the button moved the Huddle to the backup player. */
  switched: boolean;
};

/**
 * Asks what went wrong after someone presses "Playback not working?". The
 * switch to the backup player has already started by the time this opens, so
 * the form never holds up the fix.
 */
export function playbackReportView(metadata: ReportMetadata) {
  const options = Object.entries(playbackProblems).map(([value, label]) => ({
    text: plain(label),
    value,
  }));
  return {
    type: "modal",
    callback_id: playbackReportCallbackId,
    private_metadata: JSON.stringify(metadata),
    title: plain("Playback problem"),
    submit: plain("Send"),
    close: plain("Close"),
    blocks: [
      section(
        metadata.switched
          ? "I’ve switched this Huddle to the backup player. The music should be back in a few seconds."
          : "This Huddle is already using the backup player.",
      ),
      input("problems", "What went wrong?", {
        type: "checkboxes",
        action_id: "selection",
        options,
      }),
      input(
        "details",
        "Anything else?",
        {
          type: "plain_text_input",
          action_id: "text",
          multiline: true,
          max_length: detailsMaxLength,
          placeholder: plain("What did you hear or see?"),
        },
        { optional: true },
      ),
    ],
  };
}

/** A submitted report, or undefined when the submission is not one of ours. */
export function parsePlaybackReport(
  interaction: Pick<Interaction, "metadata" | "state">,
) {
  let metadata: Partial<ReportMetadata>;
  try {
    metadata = JSON.parse(interaction.metadata) as Partial<ReportMetadata>;
  } catch {
    return undefined;
  }
  if (
    typeof metadata.sessionId !== "string" ||
    typeof metadata.reportId !== "string"
  )
    return undefined;
  const problems = (
    interaction.state.problems?.selection?.selected_options ?? []
  )
    .map((option) => option.value)
    .filter((value): value is PlaybackProblem =>
      Boolean(value && Object.hasOwn(playbackProblems, value)),
    );
  const details = interaction.state.details?.text?.value
    ?.trim()
    .slice(0, detailsMaxLength);
  return {
    sessionId: metadata.sessionId,
    reportId: metadata.reportId,
    switched: Boolean(metadata.switched),
    problems,
    ...(details ? { details } : {}),
  };
}
