import { clearHistory } from "../../state";
import { NumberSetting } from "./controls";

/** Ajustes › Historial: how much of the query history is kept, and emptying it. */
export function HistorySection() {
  return (
    <>
      <div class="form-row">
        <NumberSetting setting="historyMax" label="Consultas que se guardan" unit="consultas" step={500} />
        <NumberSetting setting="historyDays" label="Días que se guardan" unit="días (0 = sin límite)" />
      </div>
      <div data-setting="Vaciar historial">
        <button type="button" class="btn" onClick={() => void clearHistory()}>Vaciar historial…</button>
      </div>
      <p class="settings-note">El historial se guarda solo en este equipo, en la carpeta de datos de Celer. Al bajar los límites se borra en el acto lo que sobra.</p>
    </>
  );
}
