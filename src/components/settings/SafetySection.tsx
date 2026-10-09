import { Toggle } from "./controls";

/** Ajustes › Seguridad: confirmations before statements that change much. */
export function SafetySection() {
  return (
    <>
      <Toggle setting="confirmNoWhere" label="Confirmar UPDATE y DELETE sin WHERE">
        En todas las conexiones, confirmar UPDATE y DELETE sin WHERE (el editor ya los subraya)
      </Toggle>
      <Toggle setting="confirmMutations" label="Confirmar en producción">
        En conexiones de producción, confirmar UPDATE/DELETE sin WHERE, DROP, TRUNCATE y ALTER
      </Toggle>
      <p class="settings-note" data-setting="Solo lectura">
        Las conexiones de solo lectura rechazan cualquier sentencia que modifique datos, también desde el núcleo en Rust. Las contraseñas se guardan en el almacén
        de credenciales del sistema operativo.
      </p>
    </>
  );
}
