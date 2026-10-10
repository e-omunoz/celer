//! Varias ventanas de Celer. Cada ventana es una página con su propio estado (sus pestañas, su explorador, sus
//! paneles); el núcleo es el único que escribe lo que comparten y les avisa con eventos:
//!
//! - abre las ventanas nuevas (solo con la interfaz de la aplicación y etiquetas `win-N` o `panel-…`, que son las
//!   que tienen permisos en `capabilities/windows.json` y `capabilities/panels.json`);
//! - lleva un buzón por ventana: una ventana deja un mensaje (una pestaña que se mueve, una acción de un panel) y
//!   el núcleo avisa a la otra con `celer://inbox`; así una ventana que aún no ha cargado no pierde nada;
//! - guarda `workspace.json` con la disposición de todas las ventanas (cada una manda la suya: un solo escritor);
//! - sigue el arrastre de una pestaña fuera de su ventana y dice dónde se soltó; fuera de toda ventana de Celer
//!   muestra bajo el puntero el contorno de la ventana nueva (`drag-ghost`, una ventana transparente que no recibe
//!   el ratón, con `public/drag-ghost.html`);
//! - dice qué ventana tiene el foco (`celer://focus`, para que Gib viva solo en una) y cuándo se abre o se cierra
//!   una (`celer://windows`).
//!
//! Las sesiones no son de ninguna ventana: viven en `AppState`, así que mover una pestaña no las toca.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{err, AppState, CmdResult};

/// Paneles que pueden ir en una ventana propia. La biblioteca y el asistente existen una vez; los demás, uno por
/// plan, diagrama o comparación.
const PANELS: &[&str] = &["library", "ai", "plan", "er", "compare", "schema-compare", "data-compare"];
const SINGLE_PANELS: &[&str] = &["library", "ai"];

#[derive(Default)]
pub struct Windows {
    /// Número de la próxima ventana completa (`win-2`, `win-3`…) y de los paneles repetibles.
    next: AtomicU32,
    inbox: Mutex<HashMap<String, Vec<Value>>>,
    /// La disposición que ha mandado cada ventana, en el orden en que se abrieron.
    layout: Mutex<Vec<(String, Value)>>,
    /// `workspace.json` no se pudo leer al arrancar (bloqueado…): no se escribe encima en esta sesión.
    frozen: AtomicBool,
    drag: Mutex<Option<Drag>>,
    /// Cada arrastre tiene su número: el hilo que mueve el contorno de un arrastre termina cuando empieza otro.
    drag_gen: AtomicU64,
    /// La última ventana completa que tuvo el foco.
    focused: Mutex<String>,
}

struct Drag {
    source: String,
    claim: Option<(String, usize)>,
}

/// El contorno que sigue al puntero mientras una pestaña se arrastra fuera de las ventanas: no es una ventana de
/// Celer (no tiene pestañas, ni disposición, ni sale en las listas).
pub const GHOST: &str = "drag-ghost";
/// Dónde queda el puntero dentro del contorno, en píxeles físicos: lo mismo que `DROP_OFFSET` en windowModel.ts,
/// así el contorno está justo donde se abrirá la ventana nueva.
const GHOST_OFFSET: (f64, f64) = (120.0, 18.0);
/// The size of the window that opens (see `window_open`, "full"), in logical pixels.
const GHOST_SIZE: (f64, f64) = (1280.0, 820.0);

/// Una ventana con pestañas (la principal o `win-N`), no un panel.
fn is_full(label: &str) -> bool {
    label == "main" || label.starts_with("win-")
}

fn rank(label: &str) -> u8 {
    if label == "main" {
        0
    } else if is_full(label) {
        1
    } else {
        2
    }
}

/// `workspace.json`, versión 2: una entrada por ventana, la principal primero. Las pestañas de la primera ventana
/// completa van también arriba, como en la versión 1, para que un Celer anterior abra al menos esas.
pub(crate) fn compose(layout: &[(String, Value)]) -> Value {
    let mut ordered: Vec<&(String, Value)> = layout.iter().collect();
    ordered.sort_by_key(|(label, _)| rank(label));
    let windows: Vec<Value> = ordered.iter().map(|(_, entry)| entry.clone()).collect();
    let first: Option<&Value> = ordered.iter().find(|(label, _)| is_full(label)).map(|(_, entry)| entry);
    let field = |name: &str, fallback: Value| first.and_then(|entry| entry.get(name)).cloned().unwrap_or(fallback);
    json!({
        "version": 2,
        "tabs": field("tabs", json!([])),
        "activeTabId": field("activeTabId", json!("")),
        "sidebarWidth": field("sidebarWidth", Value::Null),
        "windows": windows,
    })
}

impl Windows {
    fn deliver(&self, app: &AppHandle, label: &str, messages: Vec<Value>) {
        if messages.is_empty() {
            return;
        }
        self.inbox.lock().entry(label.to_string()).or_default().extend(messages);
        let _ = app.emit("celer://inbox", label);
    }

    /// Escribe la disposición de todas las ventanas (con el bloqueo puesto: dos ventanas que guardan a la vez
    /// no se pisan).
    fn save(&self, state: &AppState) -> CmdResult<()> {
        if self.frozen.load(Ordering::Relaxed) {
            return Ok(());
        }
        let layout = self.layout.lock();
        let text = serde_json::to_string(&compose(&layout)).map_err(err)?;
        state.store.write_atomic("workspace.json", &text).map_err(err)
    }
}

/// Eventos de las ventanas: el foco (Gib vive en la ventana completa con el foco) y las que se cierran.
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    match event {
        tauri::WindowEvent::Focused(true) => {
            let label = window.label().to_string();
            if is_full(&label) {
                if let Some(windows) = app.try_state::<Windows>() {
                    *windows.focused.lock() = label.clone();
                }
                let _ = app.emit("celer://focus", label);
            }
        }
        tauri::WindowEvent::Destroyed if window.label() == GHOST => {}
        tauri::WindowEvent::Destroyed => {
            if let Some(windows) = app.try_state::<Windows>() {
                windows.inbox.lock().remove(window.label());
                let mut focused = windows.focused.lock();
                if *focused == window.label() {
                    focused.clear();
                }
            }
            let _ = app.emit("celer://windows", ());
        }
        _ => {}
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// "full" (una ventana completa) o el panel que muestra.
    kind: String,
    /// Lo que la ventana encuentra en su buzón al cargar (las pestañas que se le mueven, el panel que muestra…).
    #[serde(default)]
    messages: Vec<Value>,
    /// Su esquina, en píxeles físicos del escritorio (donde se soltó la pestaña); si no, centrada.
    at: Option<[f64; 2]>,
    /// Su entrada de la disposición guardada (al restaurar la sesión): cuenta ya, aunque tarde en cargar.
    layout: Option<Value>,
}

/// Abre una ventana completa o un panel y devuelve su etiqueta. La biblioteca y el asistente, si ya están
/// abiertos, reciben los mensajes y pasan al frente.
#[tauri::command]
pub async fn window_open(app: AppHandle, windows: State<'_, Windows>, request: OpenRequest) -> CmdResult<String> {
    let kind = request.kind.as_str();
    let label = if kind == "full" {
        format!("win-{}", windows.next.fetch_add(1, Ordering::Relaxed) + 2)
    } else if SINGLE_PANELS.contains(&kind) {
        format!("panel-{kind}")
    } else if PANELS.contains(&kind) {
        format!("panel-{kind}-{}", windows.next.fetch_add(1, Ordering::Relaxed) + 2)
    } else {
        return Err("Ventana no permitida".into());
    };
    if let Some(existing) = app.get_webview_window(&label) {
        windows.deliver(&app, &label, request.messages);
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(label);
    }
    if let Some(entry) = request.layout {
        let mut layout = windows.layout.lock();
        layout.retain(|(l, _)| *l != label);
        layout.push((label.clone(), entry));
    }
    if !request.messages.is_empty() {
        windows.inbox.lock().insert(label.clone(), request.messages);
    }
    let (width, height, min_width, min_height) = match kind {
        "full" => (1280.0, 820.0, 960.0, 640.0),
        "library" | "ai" => (440.0, 760.0, 320.0, 420.0),
        _ => (1100.0, 760.0, 520.0, 360.0),
    };
    // Oculta hasta que la interfaz se coloca y pinta (sin destello blanco), como la principal.
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Celer")
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .decorations(false)
        .shadow(true)
        .visible(false)
        .center()
        .disable_drag_drop_handler()
        .build();
    let window = match built {
        Ok(window) => window,
        Err(e) => {
            windows.inbox.lock().remove(&label);
            windows.layout.lock().retain(|(l, _)| *l != label);
            return Err(err(e));
        }
    };
    if let Some([x, y]) = request.at {
        let (x, y) = clamp_to_work_area(&window, x.round() as i32, y.round() as i32);
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
    // Red de seguridad: se muestra igualmente si la interfaz no lo ha hecho al poco.
    let shown = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        if !shown.is_visible().unwrap_or(true) {
            let _ = shown.show();
        }
    });
    let _ = app.emit("celer://windows", ());
    Ok(label)
}

/// Los mensajes que esperan a esta ventana (y se vacía su buzón).
#[tauri::command]
pub fn window_inbox(window: WebviewWindow, windows: State<'_, Windows>) -> Vec<Value> {
    windows.inbox.lock().remove(window.label()).unwrap_or_default()
}

/// Deja un mensaje para otra ventana (`*`: para todas las demás). Falso si no hay ninguna con esa etiqueta.
#[tauri::command]
pub fn window_post(app: AppHandle, window: WebviewWindow, windows: State<'_, Windows>, target: String, message: Value) -> bool {
    let from = window.label().to_string();
    let targets: Vec<String> = if target == "*" {
        app.webview_windows().into_keys().filter(|label| *label != from).collect()
    } else if app.get_webview_window(&target).is_some() {
        vec![target]
    } else {
        vec![]
    };
    for label in &targets {
        windows.deliver(&app, label, vec![message.clone()]);
    }
    !targets.is_empty()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    label: String,
    title: String,
    focused: bool,
}

/// Las ventanas abiertas, con lo que muestran y cuál tuvo el foco la última.
#[tauri::command]
pub fn window_list(app: AppHandle, windows: State<'_, Windows>) -> Vec<WindowInfo> {
    let focused = windows.focused.lock().clone();
    let layout = windows.layout.lock();
    app.webview_windows()
        .into_keys()
        .filter(|label| label != GHOST)
        .map(|label| {
            let title = layout
                .iter()
                .find(|(l, _)| *l == label)
                .and_then(|(_, entry)| entry.get("title"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let is_focused = label == focused;
            WindowInfo { label, title, focused: is_focused }
        })
        .collect()
}

/// `workspace.json` al arrancar. Si no se puede leer (y no es que estuviera dañado y se haya apartado), esta
/// sesión no lo escribe.
#[tauri::command(async)]
pub fn window_layout_load(state: State<'_, Arc<AppState>>, windows: State<'_, Windows>) -> CmdResult<Value> {
    state.store.load_json("workspace.json").map_err(|e| {
        let message = e.to_string();
        if !message.contains(".unreadable-") {
            windows.frozen.store(true, Ordering::Relaxed);
        }
        message
    })
}

/// La disposición de esta ventana (pestañas, paneles, posición): se guarda con la de las demás.
#[tauri::command(async)]
pub fn window_report(app: AppHandle, window: WebviewWindow, state: State<'_, Arc<AppState>>, windows: State<'_, Windows>, entry: Value) -> CmdResult<()> {
    let label = window.label().to_string();
    let renamed = {
        let mut layout = windows.layout.lock();
        let title = entry.get("title").cloned();
        match layout.iter_mut().find(|(l, _)| *l == label) {
            Some(slot) => {
                let renamed = slot.1.get("title").cloned() != title;
                slot.1 = entry;
                renamed
            }
            None => {
                layout.push((label, entry));
                true
            }
        }
    };
    if renamed {
        let _ = app.emit("celer://windows", ());
    }
    windows.save(&state)
}

/// Una ventana se cierra para no volver (no es el cierre de Celer): sale de la disposición guardada.
#[tauri::command(async)]
pub fn window_forget(window: WebviewWindow, state: State<'_, Arc<AppState>>, windows: State<'_, Windows>) -> CmdResult<()> {
    let label = window.label().to_string();
    windows.layout.lock().retain(|(l, _)| *l != label);
    windows.inbox.lock().remove(&label);
    windows.save(&state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRect {
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
    monitor: String,
    scale: f64,
    monitors: Vec<MonitorRect>,
}

/// Dónde está esta ventana (esquina exterior y tamaño interior, en píxeles físicos) y los monitores que hay.
#[tauri::command]
pub fn window_screen(window: WebviewWindow) -> CmdResult<Screen> {
    let position = window.outer_position().map_err(err)?;
    let size = window.inner_size().map_err(err)?;
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned())
        .unwrap_or_default();
    let monitors = window
        .available_monitors()
        .map_err(err)?
        .iter()
        .map(|m| MonitorRect {
            name: m.name().cloned().unwrap_or_default(),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale: m.scale_factor(),
        })
        .collect();
    Ok(Screen {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
        monitor,
        scale: window.scale_factor().unwrap_or(1.0),
        monitors,
    })
}

/// Coloca esta ventana (la interfaz ya ha comprobado que el sitio está en un monitor que existe).
#[tauri::command]
pub fn window_place(window: WebviewWindow, x: i32, y: i32, width: u32, height: u32, maximized: bool) -> CmdResult<()> {
    window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(err)?;
    window.set_size(tauri::PhysicalSize::new(width, height)).map_err(err)?;
    if maximized {
        window.maximize().map_err(err)?;
    }
    Ok(())
}

/// Trae otra ventana de Celer al frente.
#[tauri::command]
pub fn window_raise(app: AppHandle, label: String) -> bool {
    match app.get_webview_window(&label) {
        Some(window) => {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            true
        }
        None => false,
    }
}

/// Celer was launched again while running (single-instance guard): the window used last comes to the front instead
/// of a second process that would write connections and workspace from its own stale copy.
pub fn raise_last(app: &AppHandle) {
    let last = app.try_state::<Windows>().map(|w| w.focused.lock().clone()).unwrap_or_default();
    if !window_raise(app.clone(), last) {
        window_raise(app.clone(), "main".into());
    }
}

/// "Salir de Celer": cada ventana ya ha guardado su parte de la disposición.
#[tauri::command]
pub fn window_quit(app: AppHandle) {
    app.exit(0);
}

/// Empieza el arrastre de una pestaña: las otras ventanas preparan su barra de pestañas para recibirla y, con
/// `ghost` (título, vista previa, colores del tema), fuera de las ventanas se ve el contorno de la ventana nueva.
#[tauri::command]
pub fn tab_drag_start(app: AppHandle, window: WebviewWindow, windows: State<'_, Windows>, tab: String, title: String, ghost: Option<Value>) {
    let source = window.label().to_string();
    *windows.drag.lock() = Some(Drag { source: source.clone(), claim: None });
    let generation = windows.drag_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("celer://drag", json!({ "active": true, "source": source, "tab": tab, "title": title }));
    if let Some(style) = ghost {
        follow_with_ghost(app, generation, style);
    }
}

/// Mueve la esquina (`x`, `y`) de `window` lo justo para que quepa en el área de trabajo del monitor que hay bajo ella
/// (una ventana soltada junto al borde derecho o inferior no se abre casi fuera de la pantalla).
fn clamp_to_work_area(window: &WebviewWindow, x: i32, y: i32) -> (i32, i32) {
    let Ok(size) = window.outer_size() else { return (x, y) };
    let Ok(Some(monitor)) = window.monitor_from_point(x as f64 + 120.0, y as f64 + 18.0) else { return (x, y) };
    let area = monitor.work_area();
    clamp_corner((x, y), (size.width as i32, size.height as i32), (area.position.x, area.position.y, area.size.width as i32, area.size.height as i32))
}

/// La esquina más cercana a `corner` con la ventana de `size` dentro de `area` (x, y, ancho, alto); si no cabe, su esquina superior izquierda.
fn clamp_corner(corner: (i32, i32), size: (i32, i32), area: (i32, i32, i32, i32)) -> (i32, i32) {
    let x = corner.0.min(area.0 + area.2 - size.0).max(area.0);
    let y = corner.1.min(area.1 + area.3 - size.1).max(area.1);
    (x, y)
}

/// Un rectángulo de ventana en píxeles físicos del escritorio.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn inside(point: (f64, f64), area: &Area) -> bool {
    point.0 >= area.x && point.0 < area.x + area.width && point.1 >= area.y && point.1 < area.y + area.height
}

/// La esquina del contorno para el puntero en `cursor`: la de la ventana que se abriría al soltar.
fn ghost_corner(cursor: (f64, f64)) -> (i32, i32) {
    ((cursor.0 - GHOST_OFFSET.0).round() as i32, (cursor.1 - GHOST_OFFSET.1).round() as i32)
}

/// Las ventanas de Celer a la vista (no el contorno, ni las minimizadas u ocultas).
fn visible_areas(app: &AppHandle) -> Vec<Area> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label != GHOST)
        .filter_map(|(_, w)| {
            if w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(false) {
                return None;
            }
            let p = w.outer_position().ok()?;
            let s = w.outer_size().ok()?;
            Some(Area { x: p.x as f64, y: p.y as f64, width: s.width as f64, height: s.height as f64 })
        })
        .collect()
}

/// Mientras dura el arrastre `generation`: fuera de toda ventana de Celer, el contorno sigue al puntero; dentro de
/// una, se esconde (allí la barra de pestañas enseña dónde caerá). Al terminar, se cierra.
fn follow_with_ghost(app: AppHandle, generation: u64, style: Value) {
    std::thread::spawn(move || {
        let current = |app: &AppHandle| {
            app.try_state::<Windows>()
                .map(|w| w.drag_gen.load(Ordering::SeqCst) == generation && w.drag.lock().is_some())
                .unwrap_or(false)
        };
        let data = serde_json::to_string(&style).unwrap_or_else(|_| "{}".into());
        let ghost = match app.get_webview_window(GHOST) {
            Some(existing) => {
                let _ = existing.eval(format!("window.__celerGhostUpdate && window.__celerGhostUpdate({data})"));
                existing
            }
            None => {
                let built = WebviewWindowBuilder::new(&app, GHOST, WebviewUrl::App("drag-ghost.html".into()))
                    .title("Celer")
                    .inner_size(GHOST_SIZE.0, GHOST_SIZE.1)
                    .decorations(false)
                    .transparent(true)
                    .background_color(tauri::window::Color(0, 0, 0, 0))
                    .shadow(false)
                    .resizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focused(false)
                    .focusable(false)
                    .visible(false)
                    .initialization_script(format!("window.__celerGhost = {data};"))
                    .build();
                match built {
                    Ok(window) => window,
                    Err(_) => return,
                }
            }
        };
        let _ = ghost.set_ignore_cursor_events(true);
        // Las ventanas cambian poco durante un arrastre: se miran unas veces por segundo, el puntero en cada paso.
        let mut areas = visible_areas(&app);
        let mut shown = false;
        let mut tick = 0u32;
        while current(&app) {
            std::thread::sleep(std::time::Duration::from_millis(16));
            tick = tick.wrapping_add(1);
            if tick % 15 == 0 {
                areas = visible_areas(&app);
            }
            let Ok(cursor) = ghost.cursor_position() else { continue };
            let point = (cursor.x, cursor.y);
            if areas.iter().any(|area| inside(point, area)) {
                if shown {
                    let _ = ghost.hide();
                    shown = false;
                }
                continue;
            }
            let (x, y) = ghost_corner(point);
            let _ = ghost.set_position(tauri::PhysicalPosition::new(x, y));
            if !shown {
                let _ = ghost.show();
                shown = true;
            }
        }
        // Otro arrastre ya pudo empezar y usarlo: solo se cierra si este era el último.
        if app.try_state::<Windows>().map(|w| w.drag_gen.load(Ordering::SeqCst) == generation).unwrap_or(true) {
            let _ = ghost.close();
        }
    });
}

/// La pestaña que se arrastra desde otra ventana se ha soltado en la barra de esta, en la posición `index`.
#[tauri::command]
pub fn tab_drag_claim(window: WebviewWindow, windows: State<'_, Windows>, index: usize) -> bool {
    let mut drag = windows.drag.lock();
    match drag.as_mut() {
        Some(d) if d.source != window.label() => {
            d.claim = Some((window.label().to_string(), index));
            true
        }
        _ => false,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropClaim {
    label: String,
    index: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRect {
    label: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    minimized: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragEnd {
    claim: Option<DropClaim>,
    /// Dónde está el puntero, en píxeles físicos del escritorio.
    cursor: Option<[f64; 2]>,
    windows: Vec<WindowRect>,
}

/// Termina el arrastre: qué ventana se quedó la pestaña, dónde está el puntero y dónde están las ventanas (la
/// interfaz decide: windowModel.ts, `dropTarget`).
#[tauri::command]
pub fn tab_drag_end(app: AppHandle, window: WebviewWindow, windows: State<'_, Windows>) -> DragEnd {
    let drag = windows.drag.lock().take();
    if let Some(ghost) = app.get_webview_window(GHOST) {
        let _ = ghost.hide();
    }
    let _ = app.emit("celer://drag", json!({ "active": false }));
    let claim = drag.and_then(|d| d.claim).map(|(label, index)| DropClaim { label, index });
    let cursor = window.cursor_position().ok().map(|p| [p.x, p.y]);
    let rects = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label != GHOST)
        .filter_map(|(label, w)| {
            let position = w.outer_position().ok()?;
            let size = w.outer_size().ok()?;
            let minimized = w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true);
            Some(WindowRect { label, x: position.x, y: position.y, width: size.width, height: size.height, minimized })
        })
        .collect();
    DragEnd { claim, cursor, windows: rects }
}

#[cfg(test)]
mod tests {
    use super::{clamp_corner, compose, ghost_corner, inside, Area, GHOST_OFFSET};
    use serde_json::json;

    #[test]
    fn the_ghost_sits_where_the_new_window_will_open() {
        // The pointer stays on the ghost's tab strip, at the same spot as the new window's (windowModel.ts).
        assert_eq!(ghost_corner((1000.0, 500.0)), ((1000.0 - GHOST_OFFSET.0) as i32, (500.0 - GHOST_OFFSET.1) as i32));
        assert_eq!(ghost_corner((10.4, 5.6)), (-110, -12), "near the screen's corner it may start off screen");
    }

    #[test]
    fn a_dropped_window_is_kept_on_the_screen() {
        assert_eq!(clamp_corner((1800, 900), (1280, 820), (0, 0, 1920, 1040)), (640, 220));
        assert_eq!(clamp_corner((-50, 10), (1280, 820), (0, 0, 1920, 1040)), (0, 10));
        assert_eq!(clamp_corner((10, 10), (2000, 1200), (0, 0, 1920, 1040)), (0, 0));
    }

    #[test]
    fn a_point_is_inside_a_window_up_to_its_last_pixel() {
        let area = Area { x: 100.0, y: 50.0, width: 800.0, height: 600.0 };
        assert!(inside((100.0, 50.0), &area));
        assert!(inside((899.9, 649.9), &area));
        assert!(!inside((900.0, 300.0), &area), "the right edge belongs to the next pixel");
        assert!(!inside((99.0, 300.0), &area));
        assert!(!inside((500.0, 650.0), &area));
    }

    #[test]
    fn the_layout_puts_the_main_window_first_and_its_tabs_on_top() {
        let layout = vec![
            ("win-2".to_string(), json!({ "kind": "full", "tabs": [{ "id": "b" }], "activeTabId": "b" })),
            ("panel-library".to_string(), json!({ "kind": "panel", "panel": "library", "tabs": [] })),
            ("main".to_string(), json!({ "kind": "full", "tabs": [{ "id": "a" }], "activeTabId": "a", "sidebarWidth": 300 })),
        ];
        let file = compose(&layout);
        assert_eq!(file["version"], 2);
        let windows = file["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0]["activeTabId"], "a", "the main window first");
        assert_eq!(windows[1]["activeTabId"], "b", "then the other full windows");
        assert_eq!(windows[2]["panel"], "library", "panels last");
        assert_eq!(file["tabs"][0]["id"], "a", "the main window's tabs for older versions");
        assert_eq!(file["activeTabId"], "a");
        assert_eq!(file["sidebarWidth"], 300);
    }

    #[test]
    fn without_the_main_window_the_first_full_one_goes_on_top() {
        let layout = vec![
            ("panel-ai".to_string(), json!({ "kind": "panel", "panel": "ai" })),
            ("win-3".to_string(), json!({ "kind": "full", "tabs": [{ "id": "c" }], "activeTabId": "c" })),
        ];
        let file = compose(&layout);
        assert_eq!(file["tabs"][0]["id"], "c");
        assert_eq!(file["windows"][0]["activeTabId"], "c");
        assert!(file["sidebarWidth"].is_null());
        assert_eq!(compose(&[])["tabs"], json!([]), "no windows: no tabs");
    }
}
