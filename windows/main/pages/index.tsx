/** @jsxImportSource ../../../src/compiler */

/** The route at `"/"`. No parameters, so it calls nothing. */
export default function Home() {
  return (
    <div className="card">
      <div className="title">Routing</div>
      <div className="body">
        Every route in this window is compiled into one table set. The four that are not showing
        are resident and hidden, which costs memory and nothing per frame.
      </div>
    </div>
  );
}
