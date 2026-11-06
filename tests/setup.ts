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

// framer-motion's `whileInView` needs IntersectionObserver, which jsdom does not
// implement. Without it the dashboard's cards throw on mount and nothing renders,
// so any test that clicks a tool card fails for the wrong reason. Report every
// observed element as intersecting so the animated-in state is the one under test.
class StubIntersectionObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}

  observe(target: Element): void {
    this.targets.add(target);
    queueMicrotask(() => {
      if (this.targets.has(target)) {
        this.callback([{ target, isIntersecting: true, intersectionRatio: 1 }]);
      }
    });
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  get root(): Element | Document | null {
    return null;
  }

  get rootMargin(): string {
    return '0px';
  }

  get thresholds(): number[] {
    return [0];
  }
}

const observers = globalThis as { IntersectionObserver?: unknown; ResizeObserver?: unknown };
if (!observers.IntersectionObserver) {
  observers.IntersectionObserver = StubIntersectionObserver;
}

// Same story for anything measuring layout: jsdom reports no sizes, so a stub
// that never fires is enough to keep the component tree mounted.
if (!observers.ResizeObserver) {
  observers.ResizeObserver = class StubResizeObserver {
    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}
  };
}
