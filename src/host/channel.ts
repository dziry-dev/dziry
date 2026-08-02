/**
 * The one piece of state the two threads share outside the engine's tables: a
 * lock, and two flags.
 *
 * # Why a lock at all
 *
 * The staged/live split already protects the engine's *paint* from the host's
 * writes. What it does not protect is the commit itself — `Tables::commit`
 * memcmps and copies staged over live, and if the writer is halfway through a
 * batch when that happens, the engine gets a half-applied state.
 *
 * For a style value that is one frame of wrong colour, self-correcting. For a
 * **link** column it is not: a list splice writes `firstChild` and `nextSibling`
 * across several nodes, and a copy taken between two of those writes can describe
 * a chain that loops. The engine catches it with a traversal budget and reports a
 * malformed table, which poisons the engine — so this is a correctness boundary,
 * not a tearing-artefact one.
 *
 * # Why the main thread must never block on it
 *
 * The entire point of moving app code to a Worker is that a long computation
 * cannot stop the window answering the OS. A main thread that waited for the lock
 * would have reintroduced exactly that, one level down. So the acquisition is
 * asymmetric:
 *
 *   - the **writer** may block ({@link acquire}), because nothing is waiting on it
 *   - the **engine thread** may only try ({@link tryAcquire}), and when it fails it
 *     pumps instead of ticking — servicing input, resize and repaint while leaving
 *     the staged tables strictly alone
 *
 * A `SharedArrayBuffer` rather than messages because both of those have to be
 * decided *now*, in the middle of a frame, and a `postMessage` round trip is not
 * available to a synchronous frame loop.
 */

/** Indices into the shared `Int32Array`. */
export const LOCK = 0;
export const DIRTY = 1;
export const ALIVE = 2;

const FREE = 0;
const HELD = 1;

/** Room for the three slots, with the rest reserved. */
export function createChannel(): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
  const flags = new Int32Array(sab);
  Atomics.store(flags, ALIVE, 1);
  return sab;
}

/**
 * Takes the lock, waiting if the engine thread holds it.
 *
 * Only ever called from the Worker. The wait is bounded in practice by one
 * `tick`, because that is the longest the engine thread holds it — a few
 * milliseconds — and blocking a Worker costs nothing anybody can see.
 */
export function acquire(flags: Int32Array): void {
  for (;;) {
    if (Atomics.compareExchange(flags, LOCK, FREE, HELD) === FREE) return;
    // A spurious wake or a lost race just loops. `wait` returns immediately when
    // the value already changed, which is what makes the check-then-wait safe.
    Atomics.wait(flags, LOCK, HELD);
  }
}

/**
 * Takes the lock if it is free, and says so. Never waits.
 *
 * The engine thread's only way in. A `false` here is not an error and not
 * something to retry in a loop — it means "the writer is mid-batch", and the
 * correct response is to service the window without committing.
 */
export function tryAcquire(flags: Int32Array): boolean {
  return Atomics.compareExchange(flags, LOCK, FREE, HELD) === FREE;
}

export function release(flags: Int32Array): void {
  Atomics.store(flags, LOCK, FREE);
  Atomics.notify(flags, LOCK);
}

/** Set by the writer when a batch has landed; cleared by the thread that commits it. */
export function publish(flags: Int32Array): void {
  Atomics.store(flags, DIRTY, 1);
}

export function takeDirty(flags: Int32Array): boolean {
  return Atomics.exchange(flags, DIRTY, 0) === 1;
}

/** Cleared by the engine thread to ask the Worker to stop. */
export function alive(flags: Int32Array): boolean {
  return Atomics.load(flags, ALIVE) === 1;
}

export function stop(flags: Int32Array): void {
  Atomics.store(flags, ALIVE, 0);
  Atomics.notify(flags, LOCK);
}
