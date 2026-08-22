/**
 * The explained tour: six animated figures, in the order the ideas depend on
 * each other.
 *
 * The order is the argument. The pipeline establishes where the boundary is;
 * the cascade shows what is being moved across it; struct-of-arrays explains
 * why the boundary is memory rather than a call surface; the loop shows what a
 * frame actually costs; and the last two are the cases that would break a naive
 * version of all of the above — interaction state and dynamic lists.
 */
import { useEffect } from "react";
import { Figure } from "./figures/Figure.tsx";
import { FIGURES } from "./figures/index.ts";
import { FIGURE_ORDER } from "./data.ts";

export function HowItWorks() {
  // A cold load of `/#fig-memory` lands at the top of the page: the browser
  // performs its anchor jump while the document is still an empty #root, so the
  // target does not exist yet. Repeat the jump once the figures are mounted —
  // otherwise every link in the index below is a deep link that only works if
  // you were already here.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  return (
    <>
      <p className="section-intro">
        Six mechanisms, animated. Each one plays when it scrolls into view; click any step to jump
        to it, or pause and read. If your system asks for reduced motion, nothing animates and every
        figure sits on its finished state — stepping through by hand shows the same thing.
      </p>

      <nav className="fig-index">
        {FIGURE_ORDER.map((f, i) => (
          <a key={f.id} href={`#${f.id}`}>
            <span className="fig-index-num">{i + 1}</span>
            <span>
              <strong>{f.title}</strong>
              {f.answers}
            </span>
          </a>
        ))}
      </nav>

      {FIGURES.map((spec) => (
        <Figure key={spec.id} {...spec} />
      ))}
    </>
  );
}
