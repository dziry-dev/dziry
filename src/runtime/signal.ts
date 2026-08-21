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

/**
 * What a signal can do, on top of behaving as its value.
 *
 * Split from the value type so `ReadonlySignal<T>` can be `T & Ops<T>` — see below
 * for why that intersection is the whole point.
 */
type Ops<T> = {
  readonly [BRAND]: true;
  subscribe(fn: Subscriber): () => void;
  /**
   * Compiles to a list template plus arena — see `DynList`.
   *
   * Only meaningful at build time: the callback is invoked once with a recording
   * proxy so `{t.text}` becomes a path the runtime reads from the array. It is a
   * method on the signal so authoring stays `todos.map(t => …)`.
   */
  map<Item, Out>(render: (item: Item, index: number) => Out, options: MapOptions<Item>): never;
  /**
   * The value, for code the reactive rewrite does not reach.
   *
   * The framework's own modules under `src/` are not rewritten — they are where `$`
   * is *defined* — so they read through this. Authored windows do not need it and
   * should not use it: `count` is the read.
   */
  readonly value: T;
  /** The value without capturing a dependency — see the implementations. */
  peek(): T;
};

/**
 * A signal, typed as the value it holds.
 *
 * `T & Ops<T>` rather than `{ value: T }`, and this is the type-level half of the
 * reactive rewrite rather than a convenience. `count * 2` has to *type-check*, or
 * the transform makes code work that `bun run check` still rejects — which is the
 * worst of both, since the author is told to write something the compiler refuses.
 *
 * The intersection was rejected once, for a real reason: an intersection containing
 * `number` is comparable to a number literal, so `count === 7` would type-check and
 * be `false` for ever — a signal object is not 7. The transform is what changes the
 * answer. `count === 7` is rewritten to `$(count) === 7` and is simply correct, so
 * the type is no longer promising something the runtime fails to deliver.
 *
 * That dependency runs one way and is worth stating plainly: **this type is only
 * honest where the rewrite runs.** Under `windows/`, it is. In framework code it is
 * not, which is why `Ops` still carries `value` and why `src/` reads through it.
 */
export type ReadonlySignal<T> = T & Ops<T>;

export type Signal<T> = ReadonlySignal<T> & {
  /**
   * Writes, taking a value or a function of the previous one.
   *
   * One method rather than `set` plus `update`: the ambiguity is a signal holding a
   * function, which is rare enough to document rather than design around. Same shape
   * as `@tanstack/store`'s `Atom.set`.
   */
  set(next: T | ((previous: T) => T)): void;
  /** Kept for framework code and un-migrated call sites; authors write `.set`. */
  value: T;
};

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

/**
 * A subscriber that re-captures its dependencies — a computed's invalidator, an
 * effect's re-run — carries the sets it has registered into, so a re-run can
 * leave the ones it no longer reads.
 *
 * Without this, capture was one-way: a read added the listener to the signal's
 * subscribers and nothing ever removed it. A computed whose dependency set
 * changes across recomputes — `cond ? a : b` — stayed subscribed to `a` for
 * ever: woken by every write to a signal it no longer reads, one more entry per
 * abandoned branch, without bound. Never a wrong *value* — a recompute reads
 * current deps — but unbounded bookkeeping is a leak, and instance churn
 * (pooled templates) is exactly where it would have bitten.
 */
type Tracked = Subscriber & { deps?: Set<Set<Subscriber>> };

/** Registers `listener` in `subs`, recording `subs` as one of its dependencies. */
function track(subs: Set<Subscriber>, listener: Tracked): void {
  subs.add(listener);
  listener.deps?.add(subs);
}

/** Leaves every set a tracked subscriber captured into, before it re-captures. */
function detach(t: Tracked): void {
  if (!t.deps) return;
  for (const d of t.deps) d.delete(t);
  t.deps.clear();
}

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

/**
 * Literal types widened to their base.
 *
 * `signal("/")` must be a `Signal<string>`, not a `Signal<"/">`. TypeScript widens a
 * literal when it is inferred into a mutable position, and `T & Ops<T>` reaches `T`
 * through `readonly value: T` first — so inference keeps the literal and every later
 * write becomes "Type 'string' is not assignable to type '/'". Caught by `router.ts`,
 * where it also turned `route.value === "products/new"` into a no-overlap error.
 */
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T;

export function signal<T>(initial: T): Signal<Widen<T>> {
  let current = initial;
  const subs = new Set<Subscriber>();

  // Built as a plain object, then cast.
  //
  // The members are all genuinely here; what the *type* additionally claims is that
  // a signal behaves as `T`, and the reactive rewrite is what makes that true. No
  // object literal can satisfy `T & Ops<T>` for an unresolved `T`, so this cast is
  // where the two halves of that claim meet — one place, named.
  const self = {
    [BRAND]: true,
    get value(): T {
      if (listener) track(subs, listener);
      return readValue(self as unknown as ReadonlySignal<unknown>, current);
    },
    /**
     * The value without the dependency capture. The transform routes `sig.peek`
     * here (it is in `SIGNAL_MEMBERS`), so the method has to exist — an authored
     * `sig.peek()` would otherwise compile cleanly and crash at run time.
     */
    peek(): T {
      return readValue(self as unknown as ReadonlySignal<unknown>, current);
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
    set(next: T | ((previous: T) => T)): void {
      self.value = typeof next === "function" ? (next as (p: T) => T)(current) : next;
    },
    map(render: unknown, options: unknown): never {
      return buildList(
        self as unknown as ReadonlySignal<unknown>,
        current,
        render as never,
        options as never,
      ) as never;
    },
  };

  return self as unknown as Signal<Widen<T>>;
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
  // Typed structurally rather than as `ReadonlySignal<T>` — that is `T & Ops<T>`
  // now, which no object literal can satisfy for an unresolved `T`. Same reason as
  // in `signal`: the intersection is a claim the reactive rewrite makes true, not
  // one this object can.
  let self: Ops<T> & { readonly value: T };

  const invalidate: Invalidator & Tracked = (): void => {
    if (stale) return;
    stale = true;
    notify(subs);
  };
  invalidate[INVALIDATOR] = true;
  invalidate.deps = new Set();

  self = {
    [BRAND]: true,
    get value(): T {
      if (stale) {
        // Re-capturing: leave the sets the previous computation read into
        // before capturing the new ones, or conditional reads accumulate.
        detach(invalidate);
        const outer = listener;
        listener = invalidate;
        try {
          cached = compute();
        } finally {
          listener = outer;
        }
        stale = false;
      }
      if (listener) track(subs, listener);
      return readValue(self as unknown as ReadonlySignal<unknown>, cached!);
    },
    peek(): T {
      // Still computes when stale — peek is about the *listener* not capturing,
      // not about refusing to be current.
      return untrack(() => self.value);
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
    map(render: unknown, options: unknown): never {
      return buildList(
        self as unknown as ReadonlySignal<unknown>,
        self.value,
        render as never,
        options as never,
      ) as never;
    },
  };

  return self as unknown as ReadonlySignal<T>;
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

/**
 * Reads without capturing: `fn`'s signal reads do not become dependencies of
 * whatever is evaluating — a computed, an effect — around it.
 *
 * This is the whole of what `peek` was ever planned to be at the expression
 * level: not "read a signal's value" (that is `.value`) but "read it without
 * subscribing the current computation to it".
 */
export function untrack<T>(fn: () => T): T {
  const outer = listener;
  listener = null;
  try {
    return fn();
  } finally {
    listener = outer;
  }
}

export function isSignal(value: unknown): value is ReadonlySignal<unknown> {
  return typeof value === "object" && value !== null && BRAND in value;
}

// ---------------------------------------------------------------------------
// effect, and the scope that disposes it
// ---------------------------------------------------------------------------

/**
 * Runs `fn` now and again whenever anything it read changes. The dependencies
 * are captured by the same read-tracking a computed uses — no array to declare,
 * and the captured set is *replaced* on every run, so a branch that stopped
 * reading a signal stops being woken by it.
 *
 * A function returned from `fn` is the cleanup: run before each re-run and at
 * disposal, which is where a timer or an external subscription gets torn down.
 *
 * Returns the disposer. Most callers should not keep it: an effect created in
 * a component lives for the component's lifetime, and the window's scope
 * disposes it. The handle exists for the exceptions, and because a scope
 * captures it — see {@link createScope}.
 *
 * Batching applies: writes inside a `batch` wake an effect once, at the end.
 */
export function effect(fn: () => void | (() => void)): () => void {
  let cleanup: (() => void) | void;
  let disposed = false;

  const run: Tracked = () => {
    if (disposed) return; // a queued re-run may outlive the dispose
    detach(run);
    if (cleanup) {
      const c = cleanup;
      cleanup = undefined;
      c();
    }
    const outer = listener;
    listener = run;
    try {
      cleanup = fn();
    } finally {
      listener = outer;
    }
  };
  run.deps = new Set();

  run();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    detach(run);
    if (cleanup) {
      const c = cleanup;
      cleanup = undefined;
      c();
    }
  };
  activeScope?.own(dispose);
  return dispose;
}

/**
 * An ownership boundary for effects: everything created inside `run` is
 * disposed by one `dispose()` call.
 *
 * The consumer that motivated it is pooled templates (M10): freeing an
 * instance must drop its subscriptions with no dangling edges, and "everything
 * this instance created" is exactly a scope. Windows get the same treatment on
 * quit. It is deliberately not a context API — a scope is created, run and
 * disposed; it is not read by anything in between except `effect`.
 */
export type DisposalScope = {
  /** Runs `fn` with this scope current, so effects it creates are owned. */
  run<T>(fn: () => T): T;
  /** Adds an arbitrary disposer to the scope. Runs it immediately if disposed. */
  own(dispose: () => void): void;
  /** Disposes everything owned, once. */
  dispose(): void;
};

let activeScope: DisposalScope | null = null;

export function createScope(): DisposalScope {
  const owned: (() => void)[] = [];
  let disposed = false;
  const scope: DisposalScope = {
    run(fn) {
      if (disposed) throw new Error("createScope: run() on a disposed scope");
      const outer = activeScope;
      activeScope = scope;
      try {
        return fn();
      } finally {
        activeScope = outer;
      }
    },
    own(dispose) {
      // Owning into a dead scope is a leak by another name: run it now, which
      // is the disposal the caller was asking to happen eventually anyway.
      if (disposed) dispose();
      else owned.push(dispose);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const d of owned.splice(0)) d();
    },
  };
  // A scope created inside another scope's run belongs to it: disposing the
  // outer disposes the subtree, or "nested" scopes would be "leaked" scopes.
  activeScope?.own(() => scope.dispose());
  return scope;
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

/**
 * A resource's own members, resolved to the signal only when the signal actually
 * carries them — `resource()` attaches all three as own properties, and nothing
 * else does. The ownership check is what keeps this from being `SIGNAL_MEMBERS`'s
 * mistake writ large: a plain signal holding `{ status: "shipped" }` must keep
 * resolving `order.status` to the *value's* status, and `Object.hasOwn` is what
 * tells a resource's member apart from a value's key of the same name.
 */
const RESOURCE_MEMBERS = new Set(["status", "error", "refetch"]);

export function $m<T>(value: T, key: string): unknown {
  if (
    isSignal(value) &&
    (SIGNAL_MEMBERS.has(key) ||
      (RESOURCE_MEMBERS.has(key) && Object.hasOwn(value as object, key)))
  ) {
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
