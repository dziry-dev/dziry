/** @jsxImportSource ../../src/compiler */

/**
 * The window's navigation — an ordinary component, imported, not routed.
 *
 * The `href`s are concrete paths, as on the web. Nothing checks them yet: the
 * `Href` union is generated into `routes.gen.ts` and `<a>` is not a tag the
 * compiler accepts, so these are `div`s until links are wired. When they are, a
 * typo here becomes a type error and a path of the wrong shape a build error.
 */
export function Nav() {
  return (
    <div className="nav">
      <div className="brand">dziri</div>
      <div className="links">
        <div className="link">Home</div>
        <div className="link">Routing</div>
        <div className="link">Products</div>
        <div className="link">About</div>
      </div>
    </div>
  );
}
