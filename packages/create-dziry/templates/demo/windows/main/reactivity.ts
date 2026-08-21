/**
 * State for the reactivity page.
 *
 * Its own module rather than a corner of `state.ts`, so the page's demo reads on its
 * own — and so the names cannot collide with the features page, which the compiler
 * would reject: the generated artifact imports every signal by name, and one name
 * cannot mean two things.
 *
 * Nothing here says `.value`. A read is the identifier, in a `computed` body and in
 * a handler alike; a write is `.set`. That is the whole API.
 */
import { computed, signal } from "dziry";

export type Lang = { id: number; name: string; kind: string };

export const tick = signal(3);
export const note = signal("");

// --- derived ---------------------------------------------------------------
// Each of these is an operator that a bare signal used to break. `===` compared a
// signal object to a string and was false for ever; a ternary saw an object and was
// always truthy. The rewrite unwraps the read, so they mean what they say.

export const doubled = computed(() => tick * 2);
export const isBig = computed(() => tick > 5);
export const isThree = computed(() => tick === 3);
export const parity = computed(() => (tick % 2 === 0 ? "even" : "odd"));
export const shout = computed(() => `tick is ${tick}, which is ${tick > 5 ? "big" : "small"}`);

// --- a list ----------------------------------------------------------------

export const langs = signal<Lang[]>([
  { id: 1, name: "TypeScript", kind: "compiler" },
  { id: 2, name: "Rust", kind: "engine" },
]);

export const langCount = computed(() => langs.length);

/**
 * The rows the list renders.
 *
 * Derived rather than computed per row: a list template is expanded once against a
 * recording proxy, so `{l.kind === "engine" ? … }` inside it would evaluate the proxy
 * — always truthy — and freeze one answer into every row. Anything conditional per
 * row has to arrive as data.
 */
export const langRows = computed(() =>
  langs.map((l) => ({ ...l, badge: l.kind === "engine" ? "rs" : "ts" })),
);

// --- handlers --------------------------------------------------------------
// Module-level exports, because the artifact imports each by name. `set` takes a
// value or a function of the previous one.

export const bump = () => tick.set(tick + 1);
export const drop = () => tick.set((n) => n - 1);
export const reset = () => tick.set(3);

let nextLang = 3;

export const addLang = () => {
  const name = note.trim();
  if (name === "") return;
  langs.set((ls) => [...ls, { id: nextLang++, name, kind: "added" }]);
  note.set("");
};

export const dropLang = () => langs.set((ls) => ls.slice(0, -1));
