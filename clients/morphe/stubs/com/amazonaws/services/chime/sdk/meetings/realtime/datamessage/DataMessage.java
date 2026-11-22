package com.amazonaws.services.chime.sdk.meetings.realtime.datamessage;

/**
 * Compile-only stub of the Chime SDK's data message, as Slack ships it. Its fields aren't final and
 * have no initializers, so javac reads them at run time rather than inlining constants.
 */
public final class DataMessage {
  public byte[] data;
  public String senderAttendeeId;
  public String senderExternalUserId;
  public boolean throttled;
  public String topic;
}
