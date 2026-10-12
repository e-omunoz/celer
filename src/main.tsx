import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/500.css";
import { render } from "solid-js/web";
import App from "./App";
import "./App.css";
import { installErrorCapture } from "./errorLog";

// Unhandled errors and failed calls to the core go to the local error log (Ayuda › Registro de errores).
installErrorCapture();

const root = document.getElementById("root") as HTMLElement;
if (import.meta.env.DEV && location.hash.startsWith("#giblab")) {
  // Development only: Gib's animation lab (see src/gib/GibLab.tsx).
  void import("./gib/GibLab").then(({ GibLab }) => render(() => <GibLab />, root));
} else {
  render(() => <App />, root);
}
