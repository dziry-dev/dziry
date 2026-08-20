/**
 * The second agent for channel.test.ts's blocking cases: takes a channel over
 * postMessage and acquires it, announcing before (so the test knows the worker is
 * parked in `Atomics.wait`, not still booting) and after.
 *
 * A file rather than a `data:` URL because it has to import the real `acquire` —
 * an inlined copy would test the copy.
 */
import { acquire } from "./channel.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent) => {
  const flags = new Int32Array(e.data as SharedArrayBuffer);
  postMessage("waiting");
  acquire(flags);
  postMessage("acquired");
  // Exiting here without release() is deliberate for the killed-mid-batch case:
  // the lock lives in the SharedArrayBuffer, so a dead agent leaves it HELD.
};
