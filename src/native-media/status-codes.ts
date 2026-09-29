/** MeetingSessionStatusCode values from amazon-chime-sdk-js, for `ended`. */
export const statusCodes = {
  left: 1,
  joinedFromAnotherDevice: 2,
  authenticationRejected: 3,
  atCapacity: 4,
  meetingEnded: 5,
  signalingClosedUnexpectedly: 14,
  taskFailed: 18,
  attendeeRemoved: 22,
  disconnectAudio: 25,
} as const;
