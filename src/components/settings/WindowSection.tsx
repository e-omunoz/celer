import { Choice, Toggle } from "./controls";

/** Ajustes › Ventana y pestañas: what Celer reopens on start, and what opening a table already open does. */
export function WindowSection() {
  return (
    <>
      <Toggle setting="restoreSession" label="Restaurar la sesión al iniciar">
        Restaurar la sesión al iniciar: las pestañas y las ventanas que había al cerrar Celer
      </Toggle>
      <Choice
        setting="tableTabs"
        label="Abrir una tabla ya abierta"
        options={[["reuse", "Ir a su pestaña"], ["new", "Abrir otra pestaña"]]}
        hint="Al abrir una tabla desde el explorador, la búsqueda o una clave foránea."
      />
    </>
  );
}
