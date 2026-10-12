import { api } from "../../api";
import { notify, state } from "../../state";
import { NumberSetting } from "./controls";

/** Ajustes › Avisos: how long notices stay, and the desktop notification for long queries. */
export function NotificationsSection() {
  return (
    <>
      <NumberSetting setting="toastSeconds" label="Duración de los avisos" unit="segundos" step={0.5} hint="Los errores y los avisos con botón duran el doble." />
      <NumberSetting
        setting="notifyAfter"
        label="Notificación de escritorio"
        unit="segundos (0 = nunca)"
        hint="Si una consulta tarda más que esto y Celer no está delante al terminar, avisa con una notificación del sistema."
      />
      <div class="settings-actions">
        <button type="button" class="btn" onClick={() => notify("Así se ve un aviso", "info", `Dura ${state.settings.toastSeconds.toLocaleString()} s.`)}>Probar un aviso</button>
        <button type="button" class="btn" onClick={() => void api().desktopNotify("Celer", "Así llega el aviso de una consulta larga.").catch(() => {})}>Probar la notificación</button>
      </div>
    </>
  );
}
