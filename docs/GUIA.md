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
Informix conecta por JDBC, por el Client SDK o por el driver IBM CLI (ver [Drivers de Informix](#drivers-de-informix)),
y cualquier otra base de datos entra por ODBC.

- **Producción** pide confirmación antes de un UPDATE/DELETE sin WHERE, DROP, TRUNCATE o ALTER.
- **Solo lectura** rechaza en el núcleo cualquier sentencia que modifique datos.
- **Avanzado › Script de inicio**: sentencias que se ejecutan en cada conexión que abre Celer, también al reconectar
  (`SET search_path`, `SET LOCK MODE TO WAIT 10`, `SET NAMES`…).
- Las contraseñas se guardan en el almacén de credenciales del sistema operativo, nunca en un fichero.

### El formulario

- **URL JDBC**: pega una URL en este campo, o directamente en *Servidor*, y Celer reconoce el motor y rellena
  servidor, puerto, instancia o INFORMIXSERVER, base de datos, usuario, cifrado y los parámetros que entiende:
  `jdbc:sqlserver`, `jdbc:jtds:sqlserver`, `jdbc:informix-sqli`, `jdbc:ids` (Informix por DRDA), `jdbc:postgresql`,
  `jdbc:mysql`, `jdbc:mariadb` y `jdbc:sqlite`. Debajo resume lo que ha rellenado y lo que no usa. La contraseña de la
  URL no se copia nunca: escríbela en su campo.
- **Solo los campos que aplican**: la instancia solo en SQL Server, INFORMIXSERVER y el protocolo solo en Informix, el
  usuario y la contraseña desaparecen con la autenticación de Windows, el cifrado solo donde existe.
- **Cada campo dice lo que le falta o le sobra**, debajo: un puerto metido en el servidor (con un botón para
  separarlo), un puerto fuera de 1–65535, la base que exige DRDA, una cadena ODBC sin `DSN=` ni `DRIVER=`, unos
  parámetros extra que no son `clave=valor`… Con errores no deja guardar ni probar; los avisos (un nombre repetido)
  no bloquean.

### Probar conexión

**Probar conexión** enseña cada paso con su tiempo:

| Paso | Qué mira |
|---|---|
| Resolver el nombre | El DNS del servidor (o que es una IP) |
| Abrir el puerto | Que algo escucha en ese puerto, con 5 s de límite |
| TLS | PostgreSQL negocia el cifrado aquí; MySQL dice en su saludo si lo admite; SQL Server lo negocia dentro del inicio de sesión |
| Inicio de sesión | El login con el driver de verdad, y por qué vía (driver, protocolo, Java…) |
| Base de datos | Una consulta de prueba en la base elegida |

Si falla, dice qué significa y qué hacer (nombre que no resuelve o VPN caída, puerto cerrado, cortafuegos, usuario o
contraseña, base que no existe, certificado, `pg_hba.conf`, ERROR 1130 de MySQL…) y deja el error original del driver
para copiarlo.

### Organizar las conexiones

En el explorador:

- **Carpetas**, que se pueden anidar (`Clientes/Egarsat`): créalas con Ctrl+Mayús+N o el botón de carpeta, aunque
  estén vacías; renómbralas con F2 y arrastra conexiones y carpetas para moverlas. Al borrar una carpeta, su contenido
  sube un nivel.
- **Conexiones**: F2 renombra, Ctrl+D duplica (con la contraseña guardada), F4 abre sus propiedades y Supr la borra.
  Renombrar, mover y borrar se deshacen desde el aviso que aparece abajo.
- **Favoritas** (estrella o Ctrl+Mayús+F), arriba del todo; el botón del reloj lista las **recientes**.
- **Buscar** (Ctrl+F, o empezar a escribir en el árbol): cada palabra se busca en el nombre, servidor, puerto, base,
  usuario, carpeta y motor (`pg`, `sqlserver`, `ifx`…). Los filtros rápidos dejan ver solo las favoritas, las
  conectadas, las de producción o las de un motor.
- **Orden** manual (arrastrando) o alfabético, desde el botón de opciones.
- **Exportar e importar** las conexiones (todas, una carpeta o una) en un JSON sin contraseñas, para compartirlas o
  llevarlas a otro equipo; al importar no se repiten las que ya existen.
- **Varias a la vez**: Ctrl+clic (⌘+clic en macOS) añade o quita una fila, Mayús+clic selecciona un rango tal como se
  ve en el árbol y Ctrl+Mayús+clic lo añade a lo que ya había; con el teclado, Mayús+flechas (y Mayús+Inicio/Fin)
  amplían la selección y Ctrl+A selecciona todas las filas visibles del mismo tipo que la que tiene el foco (todas las
  conexiones, todas las carpetas, todas las tablas…). Esc deja solo la fila con el foco. El menú contextual, Supr,
  Ctrl+C y Ctrl+Mayús+F actúan entonces sobre toda la selección y dicen cuántas son («Eliminar 3 conexiones»).
  - Conexiones y carpetas se seleccionan juntas: conectar, desconectar, favoritas, exportar, copiar nombres, moverlas
    (arrastrando la selección o con «Mover a…» del menú), crear una carpeta con ellas y eliminarlas con una sola
    confirmación y un solo *Deshacer*. Conectar, desconectar y exportar incluyen lo que hay dentro de las carpetas
    seleccionadas.
  - Los accesos de **Favoritas** van aparte: Supr los quita de favoritas, nunca borra las conexiones.
  - Los objetos de la base (tablas, vistas…) también van aparte: copiar sus nombres y generar un SELECT o un
    SELECT COUNT(*) de cada tabla; arrastrarlos al editor escribe sus nombres.
  - Si haces Ctrl+clic en una fila de otro grupo (un objeto con conexiones seleccionadas, por ejemplo), la selección
    empieza de nuevo en ella.
- Todo está en el menú contextual (también con la tecla Menú o Mayús+F10), con su atajo al lado.

¿Vienes de otra herramienta? **Nuevo › Importar conexiones** trae las de DBeaver y DbVisualizer, con carpetas y marcas
de producción. Las contraseñas guardadas en DBeaver solo se traen si marcas **Importar también las contraseñas
guardadas** (desmarcada de entrada): solo entonces, y al pulsar *Importar*, Celer lee el fichero cifrado de credenciales
de DBeaver; al listar las conexiones no lo abre. De una conexión Informix se traen también el `informixserver` y
el resto de propiedades de la URL (van a *Parámetros extra*).

### Conectar rápido

- Una consola conecta **en segundo plano** en cuanto se abre o se muestra: la primera ejecución no espera al login.
  Si su conexión no está conectada y no pide contraseña, también se conecta sola.
- Cada sesión entra **directamente en su base de datos y con su modo de transacción**, sin `USE` ni idas y vueltas
  después (en PostgreSQL, sin abrir una segunda conexión).
- Las conexiones de las sesiones que se cierran sin nada propio (una tabla, un recuento) quedan **libres unos minutos**
  para la siguiente de la misma configuración, que se ahorra el login. Nunca una con transacción, tablas temporales o
  `SET` propios; al desconectar o editar la conexión se cierran.
- El tiempo de conexión aparece en el tooltip de la conexión y de la pestaña, y en la salida de la primera sentencia
  de una consola que tuvo que conectar.

### Reconexión

Una conexión puede caerse con el equipo suspendido, un corte de VPN o un servidor que cierra las sesiones paradas.
Celer lo detecta y vuelve a conectar solo:

- Una sesión que lleva más de un minuto parada hace una comprobación barata antes de usarse; además, el sistema
  mantiene vivas las conexiones de SQL Server, PostgreSQL y MySQL con keepalive de TCP.
- Al volver de una suspensión o de un corte de red, Celer comprueba todas las sesiones abiertas.
- Si se cortó y no había nada que perder, la consulta sigue en la conexión nueva y la salida lo dice («Conexión
  recuperada…»). Una sentencia que modifica datos no se repite nunca, porque no se sabe si llegó a ejecutarse: Celer
  vuelve a conectar y te lo dice.
- **Si había una transacción abierta, tablas temporales o `SET` de la sesión, no se reconecta en silencio**: la
  sentencia no se ejecuta, la consola avisa de lo que se ha perdido (el servidor ya ha deshecho la transacción) y un
  COMMIT pendiente da error en lugar de fingir que guardó.
- Los fallos pasajeros al conectar (red que vuelve, servidor arrancando, errores transitorios de Azure) se reintentan
  con espera.
- El punto de la conexión en el explorador y en la pestaña dice el estado: ámbar que late mientras conecta, ámbar
  fijo si se reconectó, rojo si se perdió estado o no hay conexión; el tooltip lo explica.

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
- **Fijar resultado** (la chincheta) lo conserva al volver a ejecutar: queda en su propia pestaña de resultado, con
  la chincheta, y el nuevo resultado aparece al lado. El botón de comparar de esa pestaña lo enfrenta al resultado
  actual.
- **Comparar con…** (en la barra de resultados o en la paleta) enfrenta el resultado que ves (B) con otro que eliges
  (A): otro resultado o uno fijado de esta consola, de otra consola (también de otra conexión, por ejemplo producción
  frente a preproducción) o las filas cargadas de una tabla abierta.
  - Las filas se emparejan por la **clave primaria** cuando un lado es una tabla (una pestaña de tabla o un
    `SELECT … FROM tabla` sencillo); si no, por una columna única. En *Clave* puedes elegir una o varias columnas, o
    comparar filas enteras.
  - Verás cuántas filas son iguales, cuántas cambian y cuántas están solo en A o solo en B; las celdas cambiadas se
    marcan (al pasar el ratón, su valor en A), las filas que solo están en A aparecen tachadas y las de B al final.
    *Solo diferencias* oculta las iguales e *Intercambiar* cambia A y B.
  - *Exportar* guarda lo que ves en CSV o JSON, con una columna *estado* y, por cada columna con cambios, su valor en A.
  - Los valores se comparan por lo que significan: 12.50 y 12.5, true y 1, o una fecha escrita de dos formas son
    iguales, así que se pueden comparar resultados de dos motores distintos.
  - Se comparan las filas cargadas (hasta 200.000 por lado). Si un lado tiene más, se avisa y se ofrece *Cargar todo*;
    un resultado fijado antes de cargar todas sus páginas se queda con las que tenía.
- **Copiar** como TSV, CSV, SQL, Markdown, JSON o XML; **Exportar** a disco en streaming.
- **Mover columnas**: arrastra la cabecera de una columna y la columna entera se levanta (semitransparente, con
  sombra); las demás se apartan para abrirle hueco donde caerá y, cerca del borde, la rejilla se desplaza sola. Al
  soltarla se acomoda en su sitio; Esc durante el arrastre la devuelve a donde estaba. Con *Animaciones: Reducidas*
  las columnas saltan en lugar de deslizarse. Un clic en la cabecera sigue seleccionando la columna y Mayús+clic (o
  Mayús y arrastrar) selecciona varias.
  - Todo sigue el orden de la pantalla: la selección, las flechas y Tab, **Copiar** (con cabeceras y en todos los
    formatos), la búsqueda, el panel de registro y **Exportar**, que escribe las columnas en ese orden aunque vuelva a
    leer la consulta del servidor.
  - *Restablecer orden de columnas*, en el menú de la cabecera, vuelve al orden de la consulta. Un resultado nuevo, o
    volver a ejecutar, empieza también con el orden de la consulta (igual que los anchos).
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
- **Columnas**: se mueven arrastrando la cabecera, como en los resultados; la edición, la copia y la exportación siguen
  ese orden.
- **Importar datos** (menú de la tabla o botón de la pestaña): CSV, TSV, JSON o una hoja de Excel / OpenDocument, con
  mapeo de columnas y todo en una transacción.
  - En una hoja, Celer busca la **fila de cabeceras** (salta un título o notas que haya encima); en *Cabeceras* puedes
    elegir otra fila o ninguna. En *Rango* puedes limitar las celdas como en Excel: `B3:F200`, `B3:F` (hasta la
    última fila), `B:F` o vacío para todo.
  - Fechas, números y booleanos se importan **con su tipo** y se convierten al de cada columna: una fecha con hora en
    una columna DATE se queda con la fecha y los decimales no pasan por texto.
  - Un libro grande se lee con progreso y se puede cancelar; las filas se importan por tramos.
  - **Pegar desde Excel**: copia las celdas en Excel y pulsa Ctrl+V en el asistente (o *Pegar celdas copiadas de
    Excel*). Se leen como una hoja: con sus cabeceras, y `1.234,50`, `15/03/2024` o `VERDADERO` como número, fecha y
    booleano.
- **Pegar en la tabla**: Ctrl+V en la rejilla de una tabla pega el bloque copiado desde la celda activa como cambios
  pendientes (las filas que sobran pasan a ser filas nuevas); se guardan con *Guardar*, como cualquier edición.

Desde el menú de una tabla también se generan scripts: SELECT con los joins de sus claves, INSERT, UPDATE,
UPSERT/MERGE, DELETE, DROP y su DDL.

## Entender una base de datos

- **Plan de ejecución** (Ctrl+Mayús+E): un árbol con lo que hará el motor, filas estimadas y coste. *Plan real*
  ejecuta la consulta y mide filas y tiempos reales (PostgreSQL y MariaDB). Los avisos señalan recorridos completos
  de tablas grandes, estimaciones muy desviadas, ordenaciones que van a disco o índices que sugiere SQL Server.
- **Diagrama entidad-relación** (menú de un esquema): las tablas ordenadas por dependencias y sus relaciones. Pasa
  el ratón por una tabla para ver las suyas, busca por nombre, doble clic para abrirla (el diagrama se cierra; si
  está en su propia ventana, la tabla se abre en su ventana de Celer, que pasa al frente), y exporta a SVG.
- **Diagrama de relaciones de una tabla** (menú de la tabla, botón *Diagrama de relaciones* en su pestaña *Claves*, o
  la paleta): la tabla y las que enlazan sus claves foráneas, en los dos sentidos (a las que apunta y las que apuntan
  a ella). *Ampliar un nivel* añade las relacionadas con todas las que se ven; el **+N** de una tabla añade solo las
  suyas; el botón de mira que aparece al pasar el ratón por una tabla centra el diagrama en ella (también en el de un
  esquema entero), y *Todo el esquema* vuelve a verlas todas. Para saber qué tablas apuntan a la tuya, Celer lee las
  claves de todas las del esquema (sin sus columnas), así que en esquemas muy grandes tarda un poco.
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
  la que la abres. El atajo depende de dónde esté el foco: en el explorador crea una carpeta y en la rejilla de una
  tabla pone NULL en la celda; en el resto de Celer (editor, pestañas, paneles) abre la ventana nueva.
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

## Drivers de Informix

Informix habla dos protocolos: **SQLI**, el suyo (normalmente el puerto 9088), y **DRDA** (a menudo el 9089), que solo
existe si los DBA lo han activado. En el formulario, *Protocolo*:

| Protocolo | Qué usa | Qué necesitas |
|---|---|---|
| **Automático** (recomendado) | El Client SDK si está instalado; si no, JDBC | Lo de la opción que elija |
| SQLI (JDBC) | El driver JDBC de IBM, como DBeaver | Java 11 o superior y el driver: Celer los busca y, si faltan, los descarga cuando se lo pides |
| SQLI (Client SDK / ODBC) | El driver ODBC del Informix Client SDK | El Client SDK instalado |
| DRDA (IBM CLI) | El IBM Data Server Driver | Un listener DRDA en el servidor; Celer descarga el driver |

Por SQLI, el campo **INFORMIXSERVER** es obligatorio: el nombre del servidor (su DBSERVERNAME o un alias). En DBeaver
aparece en la URL como `informixserver=…`. **Probar conexión** dice por qué vía ha conectado.

### JDBC: Java y el driver

Celer no instala nada en el sistema ni pide permisos de administrador. Busca, por este orden:

- **Java**: la ruta de *Ajustes › Drivers*, `JAVA_HOME`, el Java que trae DBeaver, el `java` del `PATH` y el que haya
  descargado Celer. Vale cualquier Java 11 o superior.
- **Driver JDBC**: la ruta de *Ajustes › Drivers*, el que ya descargó DBeaver y el que haya descargado Celer.

Si falta algo, Celer lo dice y ofrece descargarlo a su carpeta de datos, siempre después de que lo confirmes: el driver
(1,7 MB, de Maven Central) y, solo si no hay ningún Java, Eclipse Temurin JRE 21 (unos 50 MB, de Adoptium). Cada
descarga se comprueba con su firma SHA-256, muestra el progreso y se puede cancelar. Las descargas usan el proxy del
sistema.

En *Ajustes › Drivers* se ve qué ha encontrado, se puede elegir el de DBeaver con **Usar** y **Comprobar** arranca Java
y carga el driver.

Java se arranca una sola vez para todas las conexiones JDBC (mientras escribes la contraseña) y no abre ningún puerto:
habla con Celer por su entrada y salida estándar. Celer pide a Informix bloques de 256 KB (`FET_BUF_SIZE=262144`, lo más
rápido en sus pruebas); si quieres otro valor, ponlo en *Parámetros extra*.

**Detener una consulta** funciona como en los demás motores. Si el servidor no la detiene en 5 segundos (algunos
proxies y cortafuegos se comen el aviso de cancelación de Informix), Celer corta esa conexión y abre otra en la misma
base de datos; si había una transacción abierta, avisa de que sus cambios se han deshecho. Las demás pestañas no se
enteran.

### Client SDK (ODBC)

No hace falta si conectas por JDBC. Si prefieres el driver ODBC:

1. Descárgalo de [Actian ESD](https://esd.actian.com/product/HCL_Informix/14.10/Windows_64-Bit/Client) (pide registrarse) o
   de IBM Fix Central / las descargas de Informix (con IBMid y suscripción). Elige siempre la versión de **64 bits**.
2. En el instalador, marca **ODBC Driver**. La instalación pide permisos de administrador.
3. Compruébalo en `odbcad32` (orígenes de datos ODBC de 64 bits › Controladores): debe aparecer
   **IBM INFORMIX ODBC DRIVER (64-bit)**.
4. Elige el protocolo «Automático» o «SQLI (Client SDK / ODBC)».

### DRDA

Solo funciona si el servidor escucha en DRDA. Si no (error `SQL30081N`), usa «Automático» o «SQLI (JDBC)», o pide a los
DBA un alias `drsoctcp` en `sqlhosts` (por ejemplo `miservidor_dr drsoctcp host 9089`) y su nombre en
`DBSERVERALIASES`. Por DRDA hay que indicar siempre la base de datos.

### Errores frecuentes

| Error | Qué pasa | Qué hacer |
|---|---|---|
| `IM002` | El driver ODBC del Client SDK no está instalado | Protocolo «Automático» o «SQLI (JDBC)», o instalar el Client SDK |
| `CLI0199E` | El driver IBM CLI rechaza la cadena de conexión | Revisa la base de datos y los *Parámetros extra* |
| `SQL30081N` | No hay listener DRDA en ese puerto | SQLI (JDBC), o un alias DRDA |
| -908, -761, -25596 | Servidor, puerto o INFORMIXSERVER incorrectos | SQLI suele ser el 9088; INFORMIXSERVER es el DBSERVERNAME o un alias |
| -23101, -23197 | El locale de la conexión no es el de la base | `DB_LOCALE=es_ES.819` (el de tu base) en *Parámetros extra* |

El locale de cada base se consulta con `SELECT dbs_dbsname, dbs_collate FROM sysmaster:sysdbslocale`. Celer muestra
estas explicaciones (y una guía) en lugar del error del driver.

## Instalar y actualizar

Los ficheros de cada versión tienen siempre el mismo nombre, y
`https://github.com/e-omunoz/celer/releases/latest/download/<fichero>` descarga el de la última:

| Sistema | Fichero |
|---|---|
| Windows | `Celer-Setup-Windows.exe` (instalador, para tu usuario y sin administrador) · `Celer-Portable-Windows.exe` (sin instalar) |
| macOS | `Celer-macOS.dmg` (Apple silicon e Intel) |
| Linux | `Celer-Portable-Linux.AppImage` · `Celer-Linux.deb` · `Celer-Linux.rpm` |

`SHA256SUMS.txt` trae el SHA-256 de todos (ver [SECURITY.md](../SECURITY.md)).

Celer comprueba al arrancar, y cada pocas horas, si hay una versión nueva (se desactiva en el diálogo de
actualizaciones). Solo avisa: no descarga ni ejecuta nada hasta que pulsas **Actualizar**. Entonces, en una copia
instalada con Celer Setup, descarga `Celer-Setup-Windows.exe` a su carpeta de datos local, comprueba su SHA-256 con el
`SHA256SUMS.txt` de la versión, se cierra (preguntando antes si hay trabajo sin guardar) y lo ejecuta, que actualiza con
las mismas opciones y vuelve a abrir Celer. Con **Al cerrar Celer**, la actualización se instala cuando cierres. La copia
portable, macOS y Linux no ejecutan nada: abren la página de la versión para que descargues el fichero.

Al desinstalar, el propio `uninstall.exe` se queda en la carpeta de Celer, porque Windows no deja borrar un programa
mientras se ejecuta; lo quita la siguiente instalación, o puedes borrarlo a mano.

## Dónde guarda Celer sus datos

| | Windows | macOS | Linux |
|---|---|---|---|
| Ajustes, conexiones, historial, biblioteca | `%APPDATA%\es.celer.app` | `~/Library/Application Support/es.celer.app` | `~/.local/share/es.celer.app` (o `$XDG_DATA_HOME`) |
| Contraseñas | Administrador de credenciales | Llavero | Secret Service (GNOME Keyring, KWallet) |
| Drivers descargados (IBM CLI, JDBC, Java) y el puente JDBC | `…\es.celer.app\drivers` | `…/es.celer.app/drivers` | `…/es.celer.app/drivers` |
| Actualización descargada (Celer Setup) | `%LOCALAPPDATA%\es.celer.app\updates` | — | — |

Si uno de esos ficheros se daña, Celer lo aparta con el sufijo `.unreadable-…` y avisa, en lugar de sobrescribirlo.
