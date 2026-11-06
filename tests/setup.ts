import '@testing-library/jest-dom/vitest';

// Node 22+ installs a `localStorage` getter on globalThis that returns
// `undefined` unless the process was started with `--localstorage-file`, and it
// shadows jsdom's implementation (vitest copies globals, so `window.localStorage`
// resolves to the same empty Node getter). Any test touching storage would
// otherwise see `undefined`. Give the suite a real in-memory Storage when the
// host does not provide one.
const scope = globalThis as { localStorage?: Storage };

if (!scope.localStorage) {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, String(value));
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
}
