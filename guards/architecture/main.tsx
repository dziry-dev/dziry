/** Mounts the view and fetches the measured half of it. */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Architecture } from "./Architecture.tsx";
import type { Metrics } from "./metrics.ts";

function App() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  useEffect(() => {
    // Measured server-side on every request, so a hot reload after an edit shows
    // the new line counts without a rebuild step.
    fetch("/api/metrics")
      .then((r) => r.json() as Promise<Metrics>)
      .then(setMetrics)
      .catch(() => setMetrics(null));
  }, []);

  return <Architecture metrics={metrics} />;
}

const el = document.getElementById("root");
if (!el) throw new Error("#root is missing from index.html");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
