/** @jsxImportSource ../../../src/compiler */

/** The route at `"about"`. */
export default function About() {
  return (
    <div className="card">
      <div className="title">About</div>
      <div className="body">
        A window is windows/main/index.tsx; its routes are the files under pages/. The route path
        is the file path, and a $segment is a parameter.
      </div>
    </div>
  );
}
