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
import { useRoute, useRouter } from "../../../../src/compiler/route.ts";

export default function Product() {
  const { path } = useRoute("products/$id");
  const router = useRouter();

  return (
    <div className="sunken flex flex-col gap-2 rounded-lg bg-zinc-950 p-4">
      <div className="heading text-sm font-semibold text-zinc-100">Product detail</div>
      <div className="muted text-xs text-zinc-400">
        A parameter route. Its pattern is {path}, and the window is at {router.path}. The two are
        the same string today because nothing binds a concrete id yet — the matcher is what turns
        `products/1` into this route with `id = "1"`.
      </div>
    </div>
  );
}
