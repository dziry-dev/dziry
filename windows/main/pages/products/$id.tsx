/** @jsxImportSource ../../../../src/compiler */

/**
 * The route at `"products/$id"`, nested inside the `products` layout.
 *
 * `useRoute` is called for real: the string is checked against this file's own path
 * during compilation, so renaming the file without changing the string fails the
 * build. Try it — change either one.
 *
 * `args.id` is deliberately not rendered. The recorder is correct and reaches the
 * tree correctly; what is missing is the emitter turning that read into a text
 * binding, which is the next piece of the router. Writing `{args.id}` here today
 * gets a `ParamNotEmittedError` saying exactly that, rather than a wrong answer.
 */
import { useRoute } from "../../../../src/compiler/route.ts";

export default function Product() {
  const { path } = useRoute("products/$id");

  return (
    <div className="panel">
      <div className="body">A parameter route. Its pattern is {path}, bound per navigation.</div>
    </div>
  );
}
