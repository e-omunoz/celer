import { TxSettings } from "../ConsoleSafety";
import { Toggle } from "./controls";

/** Ajustes › Seguridad: confirmations before statements that change much. */
export function SafetySection() {
  return (
    <>
      <Toggle setting="confirmNoWhere" label="Confirmar UPDATE y DELETE sin WHERE">
        Confirmar UPDATE y DELETE sin WHERE en todas las conexiones
      </Toggle>
      <Toggle setting="confirmMutations" label="Confirmar en producción">
        En conexiones de producción, confirmar UPDATE/DELETE sin WHERE, DROP, TRUNCATE y ALTER
      </Toggle>
      <p class="settings-note" data-setting="Solo lectura">
        Las conexiones de solo lectura rechazan cualquier escritura. Las contraseñas van al almacén de credenciales del sistema.
      </p>
      <TxSettings />
    </>
  );
}
