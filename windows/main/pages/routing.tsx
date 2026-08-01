/** @jsxImportSource ../../../src/compiler */

/** The route at `"routing"` — what the router does, on the route that proves it. */
export default function Routing() {
  return (
    <div className="route-card">
      <div className="route-title">Routing</div>
      <div className="route-body">
        Every route in this window is compiled into one table set. The five that are not showing
        are resident and hidden, which costs memory and nothing per frame: hidden already excludes
        a subtree from layout, paint and hit-testing.
      </div>
      <div className="route-body">
        Switching route writes one byte per route root — bounded by route count, not by node
        count. Nothing is allocated, nothing grows, nothing is rebuilt.
      </div>
    </div>
  );
}
