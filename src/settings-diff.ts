export type SettingValue =
  string | number | boolean | null | undefined | readonly string[];

export type Settings = Record<string, SettingValue>;

export type SettingChange = {
  setting: string;
  from: SettingValue;
  to: SettingValue;
};

function same(from: SettingValue, to: SettingValue) {
  if (Array.isArray(from) || Array.isArray(to)) {
    if (!Array.isArray(from) || !Array.isArray(to)) return false;
    const left = [...from].sort();
    const right = [...to].sort();
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return from === to;
}

/**
 * Compares two settings snapshots and lists what actually changed. Keys missing
 * from `after` are ignored so callers can diff partial snapshots.
 */
export function settingsChanges(
  before: Settings,
  after: Settings,
): SettingChange[] {
  return Object.entries(after).flatMap(([setting, to]) =>
    same(before[setting], to) ? [] : [{ setting, from: before[setting], to }],
  );
}

/** The setting names from a change list, for grouping and breakdowns. */
export function changedSettings(changes: readonly SettingChange[]) {
  return changes.map((change) => change.setting);
}
