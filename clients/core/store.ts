// A value components can watch. React is the client mod's global, as Slack's.

export class Store<T> {
  private listeners = new Set<() => void>();

  constructor(private value: T) {}

  get = () => this.value;

  set(value: T) {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  use(): T {
    return React.useSyncExternalStore(this.subscribe, this.get);
  }
}
