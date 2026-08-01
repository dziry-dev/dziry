/**
 * The clock every figure runs on.
 *
 * One hook, so all six animations behave the same way: they step rather than
 * loop continuously, each step owns a caption, and the caption is the thing
 * being explained — the drawing is its illustration, not the other way round.
 *
 * Three rules the figures inherit from here:
 *
 *   · Nothing plays until it is on screen, and it stops again when it leaves.
 *     Six animations running behind the fold is noise, not explanation.
 *   · `prefers-reduced-motion` disables the clock entirely and pins every step
 *     to its finished state, so the figure still reads — stepping through it by
 *     hand shows exactly what playing it would have shown.
 *   · A step can always be jumped to. Understanding runs backwards more often
 *     than it runs forwards.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type Step = {
  /** Two or three words, shown in the step rail. */
  label: string;
  /** The sentence the drawing exists to make concrete. */
  caption: string;
  /** How long this step takes when playing. */
  ms?: number;
};

const DEFAULT_MS = 2600;

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export type Timeline = {
  /** Which step is showing. */
  index: number;
  /** 0→1 through the current step. Pinned at 1 under reduced motion. */
  progress: number;
  playing: boolean;
  toggle: () => void;
  goto: (index: number) => void;
  /** Called by the figure chrome when the element enters or leaves the viewport. */
  setVisible: (visible: boolean) => void;
  reduced: boolean;
};

export function useTimeline(steps: Step[]): Timeline {
  const reduced = usePrefersReducedMotion();
  const [state, setState] = useState({ index: 0, progress: 0 });
  // `wanted` is the user's intent; `visible` is the viewport's. Playing is both.
  const [wanted, setWanted] = useState(true);
  const [visible, setVisible] = useState(false);

  const playing = wanted && visible && !reduced;

  useEffect(() => {
    if (!playing) return;

    let frame = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = now - last;
      // Six figures on one page, each rebuilding a few hundred SVG nodes per
      // frame. 40 fps is indistinguishable here and costs a third less.
      if (dt < 24) {
        frame = requestAnimationFrame(tick);
        return;
      }
      last = now;
      setState((prev) => {
        const duration = steps[prev.index]?.ms ?? DEFAULT_MS;
        const next = prev.progress + dt / duration;
        // Land on the last frame of a step before moving on, so an animation
        // that ends on a state never skips showing it.
        if (next >= 1) return { index: (prev.index + 1) % steps.length, progress: 0 };
        return { index: prev.index, progress: next };
      });
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, steps]);

  const goto = useCallback((index: number) => {
    setWanted(false);
    setState({ index, progress: 1 });
  }, []);

  const toggle = useCallback(() => setWanted((w) => !w), []);

  return {
    index: state.index,
    progress: reduced ? 1 : state.progress,
    playing,
    toggle,
    goto,
    setVisible,
    reduced,
  };
}

/**
 * Runs `onChange` when the element crosses into or out of the *reading band* —
 * the middle 40% of the viewport, not the viewport itself.
 *
 * Two reasons, and the second is the one that forced it. Six figures within
 * scroll range of each other all animating is distracting: only the one being
 * read should move. And each playing figure rebuilds a few hundred SVG nodes
 * per frame, so three at once saturates the main thread badly enough that the
 * page stops responding to input. Narrowing the band means one figure animates
 * at a time, without any cross-figure coordination.
 */
export function useOnScreen(onChange: (visible: boolean) => void) {
  const ref = useRef<HTMLElement | null>(null);
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => handler.current(entry?.isIntersecting ?? false),
      { rootMargin: "-30% 0px -30% 0px", threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return ref;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Slow at both ends. The default for anything that moves a distance. */
export const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Fast out, slow in. For things that appear rather than travel. */
export const easeOut = (t: number) => 1 - (1 - t) ** 3;

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * A sub-phase of a step: `at(p, 0.2, 0.6)` is 0 before 20%, 1 after 60%, and
 * ramps between. Lets one step hold several beats without extra state.
 */
export const at = (p: number, from: number, to: number) => clamp01((p - from) / (to - from));
