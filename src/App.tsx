import { createSignal } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";

export default function App() {
  const [version, setVersion] = createSignal("");
  getVersion().then(setVersion).catch(() => setVersion("dev"));

  return (
    <main class="container">
      <h1>Celer</h1>
      <p>Fast, lightweight desktop SQL client.</p>
      <p class="muted">v{version()}</p>
    </main>
  );
}
