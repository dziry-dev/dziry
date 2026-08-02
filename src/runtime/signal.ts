/**
 * A minimal signal graph — the runtime's only state primitive.
 *
 * Written rather than imported (`@preact/signals-core` was the alternative)
 * because the compiler needs to *recognise* signals by identity at build time,
 * and because the whole graph is ~60 lines. It stays swappable: only
 * `isSignal`, `.value` and `subscribe` are used elsewhere.
 *
 * The compile-time-first split here is deliberate. What is dynamic is the
 * *value* and the *invalidation*; what is static is which node depends on which
 * signal, and that is resolved by the compiler into a binding table. The runtime
 * never discovers a dependency — it is told.
 */

const BRAND = Symbol.for("skia-proto.signal");

export type Subscriber = () => void;

/**
 * Options for `map`. `key` is required: see `DynList.keyPath` for why.
 */
export type MapOptions<Item> = {
  key: (item: Item) => unknown;
  /**
   * Item slots to materialize up front. Defaults to headroom over the initial
   * length; exceeding it grows the arena rather than truncating.
   */
  capacity?: number;
};

export type ReadonlySignal<T> = {
  readonly [BRAND]: true;
  readonly value: T;
  subscribe(fn: Subscriber): () => void;
  /**
   * Compiles to a list template plus arena — see `DynList`.
   *
   * Only meaningful at build time: the callback is invoked once with a recording
   * proxy so `{t.text}` becomes a path the runtime reads from the array. It is a
   * method on the signal so authoring stays `todos.map(t => …)`.
   */
  map<Item, Out>(render: (item: Item, index: number) => Out, options: MapOptions<Item>): never;
};

export type Signal<T> = ReadonlySignal<T> & { value: T };

/** Currently-evaluating computed, for automatic dependency capture. */
let listener: Subscriber | null = null;

/** Batched notification depth, so one handler produces one repaint. */
let depth = 0;
const pending = new Set<Subscriber>();

/**
 * Marks a subscriber as a computed's invalidator rather than an effect.
 *
 * The distinction matters for batching. Invalidation is bookkeeping — mark stale,
 * forward — so it must run *immediately* even inside a batch, otherwise a
 * computed's dependents get notified in a later round and an effect subscribed to
 * both a signal and a computed derived from it runs twice per change.
 */
const INVALIDATOR = Symbol.for("skia-proto.invalidator");

type Invalidator = Subscriber & { [INVALIDATOR]?: true };

function notify(subs: Set<Subscriber>): void {
  // Copy first: a subscriber may unsubscribe during iteration.
  for (const s of [...subs]) {
    if ((s as Invalidator)[INVALIDATOR]) {
      s();
    } else if (depth > 0) {
      pending.add(s);
    } else {
      s();
    }
  }
}

export function signal<T>(initial: T): Signal<T> {
  let current = initial;
  const subs = new Set<Subscriber>();

  const self: Signal<T> = {
    [BRAND]: true,
    get value(): T {
      if (listener) subs.add(listener);
      return readValue(self, current);
    },
    set value(next: T) {
      if (Object.is(next, current)) return;
      current = next;
      notify(subs);
    },
    subscribe(fn: Subscriber): () => void {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    map(render, options) {
      return buildList(self, current, render as never, options as never) as never;
    },
  };

  return self;
}

/**
 * Captures a list template. Set by the compiler's JSX runtime, because the result
 * is a compiler node type that this module deliberately does not depend on.
 */
export type ListBuilder = (
  source: unknown,
  initial: unknown,
  render: (item: never, index: number) => unknown,
  options: MapOptions<never>,
) => unknown;

let buildList: ListBuilder = () => {
  throw new Error(
    "signal.map() was called outside the compiler. Lists are compiled at build " +
      "time; the runtime updates slots rather than rendering children.",
  );
};

export function setListBuilder(builder: ListBuilder): void {
  buildList = builder;
}

/**
 * A derived value. Recomputed lazily on read after any dependency changes, so a
 * computed nobody reads costs nothing.
 */
export function computed<T>(compute: () => T): ReadonlySignal<T> {
  let cached: T;
  let stale = true;
  const subs = new Set<Subscriber>();
  // Named so `readValue` and `map` can pass identity along for reference resolution.
  let self: ReadonlySignal<T>;

  const invalidate: Invalidator = (): void => {
    if (stale) return;
    stale = true;
    notify(subs);
  };
  invalidate[INVALIDATOR] = true;

  self = {
    [BRAND]: true,
    get value(): T {
      if (stale) {
        const outer = listener;
        listener = invalidate;
        try {
          cached = compute();
        } finally {
          listener = outer;
        }
        stale = false;
      }
      if (listener) subs.add(listener);
      return readValue(self, cached!);
    },
    subscribe(fn: Subscriber): () => void {
      // Priming, and it is load-bearing.
      //
      // A computed registers `invalidate` with its dependencies only *inside*
      // the `value` getter — that is what makes an unread computed free. So
      // subscribing to one that has never been read attaches `fn` to a signal
      // that is itself subscribed to nothing: the dependency changes, nothing
      // invalidates, and the subscriber never fires.
      //
      // The app did not show this because `applyTextBindings` reads every bound
      // signal before `subscribeBindings` runs. Reverse those two lines and the
      // UI silently stops updating, with no error anywhere.
      void self.value;

      subs.add(fn);
      return () => subs.delete(fn);
    },
    // A computed can hold an array too, so it gets the same list support.
    map(render, options) {
      return buildList(self, self.value, render as never, options as never) as never;
    },
  };

  return self;
}

/** Groups writes so subscribers run once at the end. */
export function batch<T>(fn: () => T): T {
  depth++;
  try {
    return fn();
  } finally {
    depth--;
    if (depth === 0) {
      const queued = [...pending];
      pending.clear();
      for (const s of queued) s();
    }
  }
}

export function isSignal(value: unknown): value is ReadonlySignal<unknown> {
  return typeof value === "object" && value !== null && BRAND in value;
}

// ---------------------------------------------------------------------------
// The two helpers the reactive transform emits
// ---------------------------------------------------------------------------

/**
 * Unwraps a signal, and passes everything else through.
 *
 * The whole reactive rewrite rests on this being decided at *run time*. The
 * transform rewrites every identifier read it sees, without knowing — or being able
 * to know — which of them are signals. `$` answers that question when the code
 * actually runs, which is why the transform needs no type information, no module
 * graph, and no scope analysis.
 *
 * Over-rewriting is therefore safe rather than merely tolerable. `$(t)` inside
 * `todos.filter(t => …)` returns `t`; a parameter shadowing a signal resolves to the
 * parameter, because that is the binding in scope. The cost of a read that was never
 * a signal is one predicate.
 */
export function $<T>(value: T): T extends ReadonlySignal<infer V> ? V : T {
  if (isSignal(value)) {
    collecting?.add(value);
    return value.value as never;
  }
  return value as never;
}

/**
 * Which signals a rewritten expression read, for the compiler to name.
 *
 * `computed` already tracks dependencies, but only well enough to *invalidate* — a
 * signal adds the listener to its own subscribers and never reports itself, so there
 * is no list to read back. The compiler needs the list: an inline expression goes
 * into the artifact as text, and every signal in that text needs an import.
 *
 * `$` is the one door every rewritten read goes through, so it is the only place
 * that has to know. Null outside a collection, which is every case but this one.
 */
let collecting: Set<ReadonlySignal<unknown>> | null = null;

export function collectReads(run: () => void): Set<ReadonlySignal<unknown>> {
  const found = new Set<ReadonlySignal<unknown>>();
  const outer = collecting;
  collecting = found;
  try {
    run();
  } finally {
    collecting = outer;
  }
  return found;
}

/**
 * `$` for the object of a member expression: `count.set(…)`, `todos.filter(…)`.
 *
 * A plain `$` would turn `count.set(5)` into `(0).set(5)`, because unwrapping is
 * exactly wrong when the property being reached for belongs to the *signal* rather
 * than to its value. The key decides:
 *
 * ```
 * count.set(5)            -> the signal   (set is the signal's)
 * todos.filter(…)         -> the array    (filter is the value's)
 * user.name               -> the object   (name is the value's)
 * todos.map(fn, { key })  -> the array    — see below
 * ```
 *
 * `map` resolves to the value deliberately. A signal's array is already handed out
 * as `compileTimeArray` during compilation, whose `map` builds a dynamic list when
 * given a key and behaves as `Array.prototype.map` otherwise. Routing `map` through
 * the signal would take that decision away from the one place that has the context
 * to make it.
 *
 * `value` is in the set so that the rewrite is safe to run against code that has not
 * migrated. `todos.value` must keep meaning the signal's value, not a `.value`
 * property on the unwrapped array — which is `undefined`, silently. It stops being
 * reachable when `.value` is removed from the type, and costs nothing until then.
 */
const SIGNAL_MEMBERS = new Set(["set", "subscribe", "value", "peek"]);

export function $m<T>(value: T, key: string): unknown {
  if (isSignal(value) && SIGNAL_MEMBERS.has(key)) {
    // Handed back whole, so the read happens at `.value` rather than here — but the
    // dependency is this signal either way, and the collector only sees `$`.
    collecting?.add(value);
    return value;
  }
  return $(value);
}

// ---------------------------------------------------------------------------
// Compile-time `.value`
// ---------------------------------------------------------------------------

/**
 * True while the compiler is evaluating the document module.
 *
 * It changes what `.value` returns for arrays: a proxy that remembers which
 * signal it came from. That makes `todos.value.map(…)` compile to a real dynamic
 * list instead of silently taking `Array.prototype.map` and freezing the initial
 * data into the IR — which would render correctly once and never update.
 *
 * Nothing about the runtime changes; the flag is only ever set by the compiler.
 */
let compiling = false;

export function setCompiling(on: boolean): void {
  compiling = on;
}

/**
 * An array that behaves exactly like the underlying one, except `map` builds a
 * compiled list against the owning signal. Everything else — `length`, indexing,
 * `filter`, iteration — passes straight through, so build-time reads still work.
 *
 * To deliberately snapshot instead, copy the array first: `[...todos.value].map(…)`
 * yields a plain array and therefore the static path.
 */
function compileTimeArray<T>(owner: ReadonlySignal<unknown>, array: T[]): T[] {
  return new Proxy(array, {
    get(target, prop, receiver) {
      if (prop === "map") {
        return (render: (item: never, index: number) => unknown, options?: MapOptions<never>) => {
          // Only a keyed call means "compile a dynamic list". Without a key this
          // is an ordinary build-time map — which matters because `computed`
          // bodies legitimately map over a signal's array, and hijacking those
          // would turn derived data into a compile error.
          if (typeof options?.key === "function") return buildList(owner, target, render, options);
          return (target as T[]).map(render as never, options as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function readValue<T>(owner: ReadonlySignal<unknown>, current: T): T {
  if (compiling && Array.isArray(current)) {
    return compileTimeArray(owner, current) as unknown as T;
  }
  return current;
}
