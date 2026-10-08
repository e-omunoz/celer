// Migration assistant (docs/DESIGN.md §16): imports connections from DBeaver and DbVisualizer.
// The core only finds and reads the files; parsing, driver mapping and conflict checks happen here.
// Nothing is written to the source tools. DBeaver's encrypted credentials-config.json is read only when the user ticks
// «Importar también las contraseñas guardadas» and presses Importar (never while listing); the passwords then go
// straight to the OS credential store (saveConnection).
import { createStore } from "solid-js/store";
import { api, errorText, isTauri } from "./api";
import { notify, refreshConnections, state } from "./state";
import type { ConnConfig } from "./types";

export * from "./migrateParse";
import { applyDbeaverCredentials, parseDbeaver, parseDbVisualizer, type Candidate } from "./migrateParse";

export const [migration, setMigration] = createStore({
  open: false,
  loading: false,
  error: "",
  candidates: [] as Candidate[],
  selected: {} as Record<string, boolean>,
  passwords: false,
  importing: false,
});

// ---------------------------------------------------------------- assistant

function sameConnection(a: ConnConfig, b: ConnConfig) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "sqlite") return a.filePath.toLowerCase() === b.filePath.toLowerCase();
  return a.host.toLowerCase() === b.host.toLowerCase() && (a.port ?? 0) === (b.port ?? 0) && a.database.toLowerCase() === b.database.toLowerCase() && a.user.toLowerCase() === b.user.toLowerCase();
}

export async function openMigration() {
  setMigration({ open: true, loading: true, error: "", candidates: [], selected: {}, passwords: false, importing: false });
  try {
    const sources = isTauri() ? await api().migrationSources() : [];
    const parsed = sources.map((s) => {
      try {
        return s.tool === "dbeaver" ? parseDbeaver(s) : parseDbVisualizer(s);
      } catch (err) {
        notify(`No se pudo leer ${s.path}`, "warning", errorText(err));
        return [] as Candidate[];
      }
    });
    const candidates = parsed.flat().map((c) => (c.status === "unsupported" ? c : state.connections.some((x) => sameConnection(x, c.cfg)) ? { ...c, status: "exists" as const, reason: "Ya existe en Celer" } : c));
    const selected: Record<string, boolean> = {};
    for (const c of candidates) selected[c.key] = c.status === "new";
    setMigration({ loading: false, candidates, selected, passwords: false });
  } catch (err) {
    setMigration({ loading: false, error: errorText(err) });
  }
}

/** Only with «Importar también las contraseñas guardadas» ticked: reads DBeaver's credentials for the chosen ones. */
async function withDbeaverCredentials(chosen: Candidate[]) {
  let out = chosen;
  for (const path of new Set(chosen.filter((c) => c.tool === "dbeaver").map((c) => c.sourcePath))) {
    try {
      const hex = await api().migrationDbeaverCredentials(path);
      if (hex) out = await applyDbeaverCredentials(out, path, hex);
    } catch (err) {
      notify("No se pudieron leer las contraseñas de DBeaver", "warning", errorText(err));
    }
  }
  return out;
}

export async function runMigration() {
  let chosen = migration.candidates.filter((c) => c.status !== "unsupported" && migration.selected[c.key]);
  if (!chosen.length) return;
  setMigration({ importing: true });
  if (migration.passwords && isTauri()) chosen = await withDbeaverCredentials(chosen);
  let imported = 0;
  const failed: string[] = [];
  for (const c of chosen) {
    const withPassword = migration.passwords && Boolean(c.cfg.password);
    try {
      await api().saveConnection({ ...c.cfg, id: "", password: withPassword ? c.cfg.password : "", savePassword: withPassword });
      imported++;
    } catch (err) {
      failed.push(`${c.cfg.name}: ${errorText(err)}`);
    }
  }
  await refreshConnections();
  setMigration({ importing: false, open: false });
  const skipped = migration.candidates.length - chosen.length;
  notify(
    `${imported} ${imported === 1 ? "conexión importada" : "conexiones importadas"}`,
    failed.length ? "warning" : "success",
    [skipped ? `${skipped} sin importar (ya existían, no soportadas o desmarcadas).` : "", failed.length ? `Fallaron: ${failed.join("; ")}` : ""].filter(Boolean).join(" ") || undefined,
  );
}
