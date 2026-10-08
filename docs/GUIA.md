# Guía de Celer

Esta guía recorre Celer de principio a fin: conectar, consultar, explorar tablas, editar datos y las herramientas
para entender una base de datos. Todo lo que aparece aquí también se encuentra desde la paleta de comandos
(**Shift Shift** o **Ctrl+K**) escribiendo parte de su nombre.

## Primeros pasos

Al abrir Celer por primera vez, una guía corta enseña la interfaz y puede crear una base de datos SQLite de ejemplo.
Puedes volver a verla desde la paleta: *Guía de inicio*.

La ventana tiene tres zonas:

- **Explorador** (izquierda, Alt+1): conexiones, bases de datos, esquemas, tablas, vistas, rutinas…
- **Pestañas** (centro): consolas SQL y tablas abiertas. Se pueden sacar a otra ventana (ver *Varias ventanas*).
- **Panel derecho** (Alt+7): el valor de una celda, la fila como formulario, el historial, la biblioteca de scripts
  (Alt+8) y el asistente de IA.

## Conexiones

**Nuevo › Conexión** (Ctrl+Alt+N) abre el formulario. PostgreSQL, MySQL/MariaDB, SQL Server y SQLite son nativos;
Informix usa el driver IBM (Celer lo descarga si hace falta) y cualquier otra base de datos entra por ODBC.

- **Probar** comprueba la conexión antes de guardarla.
- **Producción** pide confirmación antes de un UPDATE/DELETE sin WHERE, DROP, TRUNCATE o ALTER.
- **Solo lectura** rechaza en el núcleo cualquier sentencia que modifique datos.
- **Avanzado › Script de inicio**: sentencias que se ejecutan en cada conexión que abre Celer, también al reconectar
  (`SET search_path`, `SET LOCK MODE TO WAIT 10`, `SET NAMES`…).
- Las contraseñas se guardan en el almacén de credenciales del sistema operativo, nunca en un fichero.

¿Vienes de otra herramienta? **Nuevo › Importar conexiones** trae las de DBeaver (también sus contraseñas, si quieres)
y DbVisualizer, con carpetas y marcas de producción. Las carpetas se reorganizan arrastrando las conexiones.

**Desconectar** (menú de la conexión) cierra todas sus sesiones. Si hay una transacción abierta, cambios sin guardar
en una tabla o una exportación en curso, lo pregunta antes.

## La consola SQL

**Ctrl+Mayús+L** abre una consola en la conexión seleccionada.

| Atajo | Qué hace |
|---|---|
| Ctrl+Intro | Ejecuta la sentencia bajo el cursor (o la selección) |
| Ctrl+Mayús+Intro | Ejecuta el script entero |
| Ctrl+Mayús+E | Plan de ejecución |
| Ctrl+F2 | Detiene la ejecución |
| Ctrl+Alt+L | Formatea el SQL |
| Ctrl+clic, F4, Ctrl+B | Abre la tabla bajo el cursor |

- **Autocompletado**: tablas después de `FROM`/`JOIN`, columnas de las tablas de la sentencia en el resto, y
  `alias.` o `esquema.` acotan la lista.
- **Plantillas**: escribe `sel`, `selw`, `ins`, `upd`, `cte`… y pulsa Tab; los campos enlazados se rellenan a la vez.
  Las tuyas se crean en *Ajustes › Plantillas*.
- **Parámetros**: `:nombre`, `?` o `${nombre}` en una consulta abren un diálogo para darles valor antes de ejecutar.
- **UPDATE / DELETE sin WHERE** se subrayan mientras escribes y piden confirmación al ejecutarlos.
- **Transacciones**: *Auto* confirma cada sentencia; en *Manual* aparecen Commit y Rollback
  (Ctrl+Alt+Mayús+C / Ctrl+Alt+Mayús+R).
- **Ficheros**: Ctrl+O abre un `.sql`, Ctrl+S lo guarda en su sitio con la misma codificación y saltos de línea, y
  Ctrl+Mayús+S guarda como.

### Resultados

Los resultados llegan por páginas desde un cursor abierto: aunque la consulta devuelva millones de filas, solo se traen
las que ves. *Cargar todo* lee el resto con progreso y se puede cancelar.

- **Filtro rápido** sobre las filas cargadas.
- **Fijar un resultado** lo conserva al volver a ejecutar; **Comparar** lo enfrenta al resultado actual y marca las
  celdas cambiadas, las filas nuevas y las que desaparecen.
- **Copiar** como TSV, CSV, SQL, Markdown, JSON o XML; **Exportar** a disco en streaming.
- El panel derecho muestra el valor completo de una celda (JSON y XML se ven indentados) o la fila como formulario.

## Tablas

Doble clic en una tabla del explorador la abre.

- **Filtros** por columna (igual, contiene, entre, lista de valores, nulos…) o tu propio `WHERE` y `ORDER BY`. Si
  escribes `"texto"` donde querías `'texto'`, Celer lo avisa y lo corrige en un clic.
- **Orden** en el servidor (clic en la cabecera) y **Contar** para el total exacto.
- **Editar**: doble clic o F2 en una celda.
  - Los booleanos se cambian con `t`, `f` o la barra espaciadora.
  - Las fechas tienen un calendario.
  - Las claves foráneas ofrecen las filas de la tabla referenciada, que puedes buscar por nombre.
  - Alt+Insert añade una fila, Supr borra las seleccionadas y Ctrl+Mayús+N pone NULL.
- **Guardar** (Ctrl+Intro) enseña el SQL antes de ejecutarlo todo en una transacción; si algo falla, no se guarda
  nada. Cada cambio pendiente se puede deshacer por celda o por fila.
- **Claves foráneas**: las columnas FK llevan ↗ en la cabecera. Ctrl+clic en un valor abre la fila referenciada.
- **Importar datos** (menú de la tabla): CSV, TSV, JSON o una hoja de Excel / OpenDocument, con mapeo de columnas y
  todo en una transacción.

Desde el menú de una tabla también se generan scripts: SELECT con los joins de sus claves, INSERT, UPDATE,
UPSERT/MERGE, DELETE, DROP y su DDL.

## Entender una base de datos

- **Plan de ejecución** (Ctrl+Mayús+E): un árbol con lo que hará el motor, filas estimadas y coste. *Plan real*
  ejecuta la consulta y mide filas y tiempos reales (PostgreSQL y MariaDB). Los avisos señalan recorridos completos
  de tablas grandes, estimaciones muy desviadas, ordenaciones que van a disco o índices que sugiere SQL Server.
- **Diagrama entidad-relación** (menú de un esquema): las tablas ordenadas por dependencias y sus relaciones. Pasa
  el ratón por una tabla para ver las suyas, busca por nombre, doble clic para abrirla, y exporta a SVG.
- **Comparar esquemas**: en el menú de un esquema, *Marcar para comparar*; después, en el de otro (de la misma
  conexión o de otra), *Comparar con…*. Verás las tablas que solo están en un lado y las columnas con otro tipo o
  nulabilidad. *Script para igualar el destino* abre en una consola del destino el SQL que lo dejaría como el origen,
  para revisarlo antes de ejecutarlo; lo que borraría datos queda comentado.
- **Comparar datos** de dos tablas: *Marcar para comparar datos* en el menú de una tabla y *Comparar datos con…* en
  el de la otra. Las filas se emparejan por la clave primaria; se marcan las celdas cambiadas (al pasar el ratón se ve
  el valor del destino), las filas que solo están en una y las nuevas. El script para igualar el destino lleva INSERT y
  UPDATE; los DELETE van comentados. Se comparan hasta 50.000 filas por tabla.
- **Actividad del servidor** (menú de la conexión): sesiones y consultas en curso, con cancelar y matar.

## Biblioteca de scripts

Las consultas que repites, guardadas con nombre en la carpeta de datos de Celer (`library.json`). Se abre con
**Alt+8**, con el botón del libro en la barra lateral o en la pestaña *Biblioteca* del panel derecho.

- **Guardar**: **Ctrl+Alt+B** guarda la consola con un nombre y una carpeta. En una consola abierta desde la
  biblioteca, el mismo atajo (o el botón del marcador en la barra de la consola) guarda sus cambios; un punto naranja
  avisa de que hay cambios sin guardar. *Guardar la consola en la biblioteca como script nuevo* crea otro.
- **Buscar**: el cuadro busca en el nombre, la carpeta, las etiquetas y el SQL; `#etiqueta` filtra por etiqueta (o haz
  clic en ella). Los scripts también salen en la paleta (**Shift Shift**).
- **Abrir y ejecutar**: clic o **Intro** abre el script en su consola (si ya está abierta, va a ella);
  **Ctrl+Intro** o el botón ▶ lo abre y lo ejecuta entero. Arrastrado al editor, pega su SQL donde lo sueltes.
- **Organizar**: carpetas y subcarpetas (botón de carpeta nueva o clic derecho), etiquetas y una conexión asociada
  (lápiz o **Alt+Intro**). Arrastra scripts y carpetas para moverlos. El menú **⋯** ordena por nombre o por uso y
  muestra solo los de la conexión activa.
- **Teclado**: flechas para moverse (← → pliegan y despliegan), **F2** renombra, **Ctrl+D** duplica, **Ctrl+C**
  copia el SQL, **Supr** borra y **Mayús+F10** abre el menú.
- **Borrar** no pregunta: el aviso que aparece tiene **Deshacer**. Borrar una carpeta con scripts sí pide
  confirmación (y también se puede deshacer).
- **Importar y exportar**: *Importar ficheros .sql* crea un script por fichero en la carpeta seleccionada. Un script
  se exporta como SQL normal; una carpeta o la biblioteca entera, en un solo `.sql` que sigue ejecutándose como script
  y que, al importarlo, recupera los scripts con sus carpetas y etiquetas.

La biblioteca de versiones anteriores se lee tal cual: los scripts quedan fuera de carpetas y sin etiquetas.

## Asistente de IA y servidor MCP

El asistente (Ctrl+Alt+I) escribe, explica, corrige y optimiza SQL con Claude usando la estructura de tu base de
datos, nunca tus filas. Necesita una clave de API de Anthropic (*Ajustes › IA y MCP*).

El **servidor MCP** (`celer.exe --mcp`) deja que Claude Desktop, Claude Code y otros clientes MCP usen tus conexiones
con un nivel de permiso por conexión (ninguno, solo estructura, lectura o escritura), límites de filas y de tiempo,
columnas enmascaradas y un registro de auditoría.

## Varias ventanas

Celer puede tener varias ventanas, por ejemplo una en cada monitor. Todas comparten las conexiones guardadas, la
biblioteca, los ajustes, el tema, los atajos y a Gib; cada una tiene sus pestañas, su explorador y su panel derecho.

- **Ventana nueva**: **Ctrl+Mayús+N** (o *Nuevo › Nueva ventana*). Se abre conectada a lo mismo que la ventana desde
  la que la abres.
- **Sacar una pestaña**: arrástrala fuera de la barra de pestañas y suéltala donde quieras: la ventana nueva aparece
  ahí. También con el botón derecho sobre la pestaña: *Mover a una ventana nueva*.
- **Llevarla a otra ventana**: arrástrala a la barra de pestañas de otra ventana de Celer (se marca al pasar por
  encima) o elige *Mover a la ventana…* en el menú de la pestaña o en la paleta.
- **La sesión no se toca**: una consola movida sigue con la misma conexión, la transacción abierta, las filas que
  faltaban por cargar y las tablas `#temp`. Mientras ejecuta o carga no se puede mover; espera o detenla.
- **Paneles en su propia ventana**: la biblioteca, el asistente de IA, el plan de ejecución, el diagrama E-R y las
  comparaciones tienen un botón *Abrir en su propia ventana* (y *Abrir el panel en su propia ventana* en la paleta).
  La biblioteca y el asistente trabajan con la consola activa de la última ventana de Celer que usaste. *Acoplar* lo
  devuelve a su sitio.
- **Cerrar**: al cerrar una ventana que no es la última, Celer pregunta qué hacer con las pestañas que perderían
  trabajo (una transacción abierta, cambios en una tabla, una consola sin guardar): moverlas a la ventana principal o
  descartarlas. Cerrar la ventana principal con otras abiertas pregunta si quieres salir de Celer o cerrar solo esa.
  Cerrar la última sale de Celer, como siempre.
- **Al volver**: *Salir de Celer* (paleta) cierra todas las ventanas y la próxima vez se abren como estaban, con sus
  pestañas, en su sitio y en su monitor. Si un monitor ya no está, la ventana aparece en uno que sí. Cerrar las
  ventanas una a una hace que solo vuelva la última.

Gib vive en una sola ventana: la que estás usando.

## Personalizar

*Ajustes* (Ctrl+Alt+S):

- **Apariencia**: ocho temas, color de acento, densidad, tamaño de la interfaz, Gib y animaciones.
- **Editor y resultados**: tamaño del editor, filas por página, filas alternas y parámetros.
- **Plantillas**: las tuyas, junto a las de serie.
- **Atajos de teclado**: pulsa **+** junto a una acción y después la combinación. Si ya la usa otra acción, Celer
  ofrece moverla. Con AltGr se siguen escribiendo €, @ o # aunque coincidan con un atajo.
- **Seguridad**: confirmaciones de UPDATE/DELETE sin WHERE y en producción.

## Gib

Gib piensa mientras corren las consultas, tiene una idea cuando termina una larga y te da consejos. Cuando no haces
nada un rato se entretiene: bosteza, se va a por un café, programa con su portátil, hace malabares, lee o baila. Si
le persigues con el ratón mientras espera, aparta el cursor como a una mosca.

- **Un consejo**: haz clic en él (o *Gib: un consejo* en la paleta). *Otro consejo* pasa al siguiente; primero salen
  los que no has visto.
- **Por su cuenta**: unos minutos después de empezar y como mucho uno cada 15 minutos, solo cuando haces una pausa,
  nunca con una consulta en marcha ni en una conexión de producción, y solo consejos que no has visto. Se cierra solo,
  al escribir o con *Cerrar*; *No más consejos* lo pone en silencio.
- **Sobre la consulta que acabas de lanzar**: avisa de `= NULL` (que nunca es cierto), de `NOT IN (SELECT …)` con
  nulos y de tablas separadas por comas sin `WHERE`; si la consulta tardó, de `LIKE '%…'`, de funciones sobre columnas
  en el `WHERE`, de `UNION` frente a `UNION ALL` y de `ORDER BY` sin límite. Si repites una consulta, propone guardarla
  en la biblioteca. Cada aviso sale una vez por sesión y los consejos, como mucho dos veces.
- *Gib: volver a contar los consejos desde el principio* (paleta) hace que vuelvan a salir todos.

En *Ajustes › Apariencia* se puede poner en silencio (solo avisos, sin consejos por su cuenta) o apagar. Con
*Animaciones: reducidas*, o si el sistema lo pide, se queda quieto. Cuando la ventana no está en primer plano deja de
animarse.

## Dónde guarda Celer sus datos

| | Windows | macOS | Linux |
|---|---|---|---|
| Ajustes, conexiones, historial, biblioteca | `%APPDATA%\es.celer.app` | `~/Library/Application Support/es.celer.app` | `~/.local/share/es.celer.app` (o `$XDG_DATA_HOME`) |
| Contraseñas | Administrador de credenciales | Llavero | Secret Service (GNOME Keyring, KWallet) |

Si uno de esos ficheros se daña, Celer lo aparta con el sufijo `.unreadable-…` y avisa, en lugar de sobrescribirlo.
