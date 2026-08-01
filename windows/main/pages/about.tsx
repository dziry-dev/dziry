/** @jsxImportSource ../../../src/compiler */

/** The route at `"about"`. */
export default function About() {
  return (
    <div className="route-card">
      <div className="route-title">About</div>
      <div className="route-body">
        A window is windows/main/index.tsx; its routes are the files under pages/. The route path
        is the file path, and a $segment is a parameter.
      </div>
    </div>
  );
}
