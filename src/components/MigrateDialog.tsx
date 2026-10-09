import { KeyRound } from "lucide-solid";
import { createMemo, For, Show } from "solid-js";
import { gibShows } from "../state";
import { Gib } from "../gib/Gib";
import { EngineIcon } from "../icons";
import { migration, runMigration, setMigration, toolLabel, type Candidate } from "../migrate";
import { Dialog } from "./Modals";

/** Migration assistant: a checklist of the connections found in DBeaver and DbVisualizer. */
export function MigrateDialog() {
  const close = () => !migration.importing && setMigration({ open: false });
  const groups = createMemo(() => {
    const out: { label: string; items: Candidate[] }[] = [];
    for (const c of migration.candidates) {
      const label = `${toolLabel(c.tool)}${c.project && c.tool === "dbeaver" ? ` · proyecto ${c.project}` : ""}`;
      const group = out.find((g) => g.label === label) ?? (out.push({ label, items: [] }), out[out.length - 1]);
      group.items.push(c);
    }
    return out;
  });
  const importable = () => migration.candidates.filter((c) => c.status !== "unsupported");
  const chosen = () => importable().filter((c) => migration.selected[c.key]).length;
  const hasDbeaver = () => migration.candidates.some((c) => c.tool === "dbeaver" && c.status !== "unsupported");
  const hasDbvis = () => migration.candidates.some((c) => c.tool === "dbvisualizer");
  const setAll = (on: boolean) => {
    const selected: Record<string, boolean> = {};
    for (const c of importable()) selected[c.key] = on && c.status === "new";
    setMigration({ selected });
  };
  const where = (c: Candidate) =>
    c.cfg.kind === "sqlite" ? c.cfg.filePath || "fichero" : `${c.cfg.host}${c.cfg.instance ? `\\${c.cfg.instance}` : ""}${c.cfg.port ? `:${c.cfg.port}` : ""}${c.cfg.database ? ` / ${c.cfg.database}` : ""}`;

  return (
    <Dialog title="Importar conexiones" class="migrate-dialog" onClose={close}>
      <Show
        when={!migration.loading && migration.candidates.length}
        fallback={
          <div class="mig-empty">
            <Show when={gibShows("overlays")}><Gib size={84} pose={migration.loading ? "laptop" : "poker"} mood={migration.loading ? "busy" : "think"} /></Show>
            <div>
              <h3>{migration.loading ? "Buscando DBeaver y DbVisualizer…" : "No hay nada que importar"}</h3>
              <p class="muted">
                {migration.loading
                  ? "Leo sus ficheros de configuración; no modifico nada."
                  : migration.error || "No he encontrado conexiones de DBeaver ni de DbVisualizer en este equipo."}
              </p>
            </div>
          </div>
        }
      >
        <p class="dialog-lead">
          He encontrado {migration.candidates.length} {migration.candidates.length === 1 ? "conexión" : "conexiones"}. Elige cuáles traer: se guardan en carpetas
          con el nombre de cada herramienta y nada cambia en el origen.
        </p>
        <div class="mig-tools">
          <button type="button" class="link small" onClick={() => setAll(true)}>Marcar las nuevas</button>
          <button type="button" class="link small" onClick={() => setAll(false)}>Desmarcar todas</button>
        </div>
        <div class="mig-list">
          <For each={groups()}>
            {(group) => (
              <>
                <div class="mig-group">{group.label}</div>
                <For each={group.items}>
                  {(c) => (
                    <label class="mig-row" classList={{ off: c.status === "unsupported" }}>
                      <input
                        type="checkbox"
                        disabled={c.status === "unsupported" || migration.importing}
                        checked={Boolean(migration.selected[c.key])}
                        onChange={(event) => setMigration("selected", c.key, event.currentTarget.checked)}
                      />
                      <EngineIcon kind={c.cfg.kind} size={16} />
                      <span class="mig-name">
                        <b>{c.cfg.name}</b>
                        <small>{c.status === "unsupported" ? c.driver : where(c)}</small>
                      </span>
                      <span class="spacer" />
                      <Show when={c.savedPassword && c.status !== "unsupported"}><span class="mig-key" title="DBeaver guarda su contraseña"><KeyRound size={12} /></span></Show>
                      <Show when={c.status !== "new"}><span class="tag" classList={{ warn: c.status === "unsupported" }}>{c.status === "exists" ? "Ya existe" : "No soportado"}</span></Show>
                      <Show when={c.cfg.production}><span class="tag prod tiny">PROD</span></Show>
                    </label>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
        <Show when={hasDbeaver()}>
          <label class="toggle-line mig-pass">
            <input type="checkbox" checked={migration.passwords} disabled={migration.importing} onChange={(event) => setMigration({ passwords: event.currentTarget.checked })} />
            <span>Importar también las contraseñas guardadas</span>
          </label>
          <p class="mig-note">
            Solo si la marcas, Celer lee el fichero cifrado de credenciales de DBeaver (usuario y contraseña) al importar, y las contraseñas van al
            almacén de credenciales del sistema. Sin marcarla, Celer te pedirá la contraseña la primera vez que conectes.
          </p>
        </Show>
        <Show when={hasDbvis()}>
          <p class="mig-note">Las contraseñas de DbVisualizer no se importan: Celer te las pedirá la primera vez que conectes.</p>
        </Show>
      </Show>
      <footer>
        <button type="button" class="btn" onClick={close}>{migration.candidates.length ? "Cancelar" : "Cerrar"}</button>
        <Show when={migration.candidates.length}>
          <button type="button" class="btn primary" disabled={!chosen() || migration.importing} onClick={() => void runMigration()}>
            {migration.importing ? "Importando…" : `Importar ${chosen()} ${chosen() === 1 ? "conexión" : "conexiones"}`}
          </button>
        </Show>
      </footer>
    </Dialog>
  );
}
