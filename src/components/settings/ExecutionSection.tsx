import { saveSettings, state } from "../../state";
import { Field, NumberSetting } from "./controls";

/** Ajustes › Ejecución: how long a console statement may run, and the transaction mode new consoles start in. */
export function ExecutionSection() {
  const s = () => state.settings;
  return (
    <>
      <NumberSetting
        setting="queryTimeout"
        label="Tiempo máximo de una consulta"
        unit="segundos (0 = sin límite)"
        hint="Pasado ese tiempo Celer cancela la sentencia de la consola, igual que el botón Detener, en cualquier motor."
      />
      <Field label="Modo de transacción de las consolas nuevas">
        <div class="seg">
          <button type="button" classList={{ on: s().autocommitDefault }} onClick={() => void saveSettings({ autocommitDefault: true })}>Automático (auto-commit)</button>
          <button type="button" classList={{ on: !s().autocommitDefault }} onClick={() => void saveSettings({ autocommitDefault: false })}>Manual (Commit / Rollback)</button>
        </div>
      </Field>
      <p class="settings-note">
        En modo manual cada consola abre su transacción con la primera sentencia y no se guarda nada hasta pulsar Commit. Cada consola puede cambiar de modo en su
        barra; las que ya están abiertas conservan el suyo.
      </p>
    </>
  );
}
