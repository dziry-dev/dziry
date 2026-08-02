/**
 * Un-internable markers, for values that must not evaluate away.
 *
 * Two parts of the compiler hand out objects that stand for something no build can
 * know — a list row and a route parameter — and both face the same hazard:
 * JavaScript will happily stringify one. `` `${t.title}` `` used to produce
 * `"[item.title]"`, which interned as an ordinary literal and rendered frozen into
 * every row while the build printed a success line. A plausible-looking wrong answer
 * is the worst outcome available, so a stringified recorder produces a marker
 * instead, and `internString` refuses markers.
 *
 * This is that mechanism, once. It was written three times before anyone noticed —
 * the marks were byte-identical in shape and the predicates differed only in which
 * constant they closed over. The third, `sentinel("route")`, is gone: it existed to
 * make `router.path.value` compile to a binding, which the reactive rewrite now does
 * for every signal. Sharing the plumbing is what made that deletion a one-line
 * change instead of an archaeology exercise.
 *
 * **The kinds stay distinct**, which is the part worth keeping. A list item's read
 * is a path into a row; a parameter's is a name the matcher binds. They arrive at
 * the same functions and mean different things, so one shared brand would let the
 * compiler mistake one for another exactly where the difference decides where the
 * value comes from. Sharing the plumbing is not sharing the identity.
 */

export type Sentinel = {
  /** The marker for `payload`, wrapped so it can be found inside a larger string. */
  wrap(payload: string): string;
  /** True if `text` is, or contains, one of these markers. */
  has(text: string): boolean;
  /** The first payload in `text`, or null. */
  payloadOf(text: string): string | null;
  /**
   * `text` split into literal and marked parts, in order.
   *
   * What makes interpolation compilable rather than merely detectable:
   * `` `at ${router.path.value}` `` becomes `["at ", <marked>]`, which is the shape
   * a dynamic text run already has.
   */
  split(text: string): Array<{ literal: string } | { payload: string }>;
};

/**
 * A family of markers.
 *
 * NUL-delimited, which is the part that makes `has` a guarantee rather than a
 * heuristic: a NUL cannot occur in authored markup, so a `.includes` against the
 * mark can only be true of a string this file produced. Two of the three copies
 * this replaces had drifted to a spaced ` dziri:param ` form, which an author could
 * in principle type; the strictest of the three is the one worth keeping.
 *
 * The kind is inside the mark, so `has` never confuses one family with another.
 */
export function sentinel(kind: string): Sentinel {
  const mark = `\0dziri:${kind}\0`;

  return {
    wrap: (payload) => `${mark}${payload}${mark}`,
    has: (text) => text.includes(mark),
    payloadOf: (text) => text.split(mark)[1] ?? null,

    split(text) {
      // `a<mark>p<mark>b` splits to ["a", "p", "b"], so odd indices are payloads.
      const pieces = text.split(mark);
      const out: Array<{ literal: string } | { payload: string }> = [];

      for (const [i, piece] of pieces.entries()) {
        if (i % 2 === 1) out.push({ payload: piece });
        else if (piece !== "") out.push({ literal: piece });
      }
      return out;
    },
  };
}
