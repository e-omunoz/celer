import { Bug, Camera, ExternalLink, FolderOpen, ImagePlus, Lightbulb, PenLine, Trash2, X } from "lucide-solid";
import { createSignal, For, Show } from "solid-js";
import { isTauri } from "../api";
import { entryTime } from "../errorLogText";
import { AREAS, draftProblems, issueText, issueUrl, parseIssueUrl, sentLink, type ReportKind } from "../report";
import {
  addImage,
  captureWindow,
  closeReport,
  currentIssue,
  deleteDraft,
  editDraft,
  forgetSent,
  imageFromFile,
  openReport,
  removeImage,
  replaceImage,
  report,
  resumeDraft,
  sendReport,
  setReport,
  setSentLink,
  switchKind,
} from "../reportStore";
import { copyText, notify, revealPath } from "../state";
import { ImageAnnotator } from "./ImageAnnotator";
import { Dialog } from "./Modals";

async function openLink(url: string) {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener");
}

/** «Reportar / Sugerir»: a bug or an idea for Celer's GitHub, previewed before anything leaves. */
export function ReportDialog() {
  const title = () =>
    report.view === "mine" ? "Mis reportes" : report.view === "sent" ? "Reporte abierto en GitHub" : report.draft.kind === "bug" ? "Reportar un fallo" : "Sugerir una mejora";
  return (
    <div classList={{ "report-hidden": report.capturing }}>
      <Dialog title={title()} wide class="report" onClose={closeReport}>
        <Show when={report.view === "form"}><ReportForm /></Show>
        <Show when={report.view === "preview"}><ReportPreview /></Show>
        <Show when={report.view === "sent"}><ReportSent /></Show>
        <Show when={report.view === "mine"}><MyReports /></Show>
      </Dialog>
    </div>
  );
}

function KindSwitch() {
  const pick = (kind: ReportKind) => switchKind(kind);
  return (
    <div class="seg report-kind">
      <button type="button" classList={{ on: report.draft.kind === "bug" }} onClick={() => pick("bug")}><Bug size={13} /> Reportar un fallo</button>
      <button type="button" classList={{ on: report.draft.kind === "idea" }} onClick={() => pick("idea")}><Lightbulb size={13} /> Sugerir una mejora</button>
    </div>
  );
}

function ReportForm() {
  const d = () => report.draft;
  const [annotating, setAnnotating] = createSignal<string | null>(null);
  const [dragging, setDragging] = createSignal(false);
  const missing = () => draftProblems(d());

  const addFiles = async (files: FileList | File[] | null | undefined) => {
    for (const file of [...(files ?? [])].filter((f) => f.type.startsWith("image/"))) {
      try {
        addImage({ name: file.name.replace(/\.[^.]+$/, "") || "imagen", dataUrl: await imageFromFile(file) });
      } catch (err) {
        notify("No se pudo añadir la imagen", "error", String(err));
      }
    }
  };

  const area = (field: "happened" | "expected" | "steps" | "what" | "why", label: string, placeholder: string, rows = 3) => (
    <label class="field">
      <span>{label}</span>
      <textarea rows={rows} value={d()[field]} placeholder={placeholder} onInput={(event) => editDraft({ [field]: event.currentTarget.value })} />
    </label>
  );

  return (
    <div
      class="report-body"
      classList={{ dragging: dragging() }}
      onPaste={(event) => {
        const files = event.clipboardData?.files;
        if (files?.length && [...files].some((f) => f.type.startsWith("image/"))) {
          event.preventDefault();
          void addFiles(files);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void addFiles(event.dataTransfer?.files);
      }}
    >
      <Show
        when={!annotating()}
        fallback={
          <ImageAnnotator
            src={d().images.find((img) => img.id === annotating())?.dataUrl ?? ""}
            onCancel={() => setAnnotating(null)}
            onDone={(dataUrl) => {
              replaceImage(annotating()!, dataUrl);
              setAnnotating(null);
            }}
          />
        }
      >
        <div class="report-top">
          <KindSwitch />
          <span class="spacer" />
          <button type="button" class="link small" onClick={() => setReport("view", "mine")}>Mis reportes</button>
        </div>
        <label class="field">
          <span>Título</span>
          <input
            value={d().title}
            maxLength={120}
            placeholder={d().kind === "bug" ? "Al exportar a Excel se cierra la ventana" : "Atajo para duplicar una pestaña"}
            ref={(el) => queueMicrotask(() => el.focus())}
            onInput={(event) => editDraft({ title: event.currentTarget.value })}
          />
        </label>
        <Show
          when={d().kind === "bug"}
          fallback={
            <>
              {area("what", "Qué te gustaría", "Cómo debería funcionar, qué debería hacer Celer…", 4)}
              {area("why", "Para qué / por qué", "La tarea que quieres hacer y qué te lo impide hoy")}
              <label class="field">
                <span>Área</span>
                <select value={d().area} onChange={(event) => editDraft({ area: event.currentTarget.value })}>
                  <option value="">(sin elegir)</option>
                  <For each={AREAS}>{(a) => <option value={a}>{a}</option>}</For>
                </select>
              </label>
            </>
          }
        >
          {area("happened", "Qué ha pasado", "Lo que hiciste y lo que viste (el mensaje de error, si lo hubo)", 4)}
          {area("expected", "Qué esperabas", "Lo que debería haber pasado", 2)}
          {area("steps", "Pasos para reproducirlo", "1. Conectar a…\n2. Ejecutar…\n3. Ver…", 3)}
        </Show>

        <div class="report-images">
          <div class="report-images-bar">
            <span class="field-label">Imágenes</span>
            <button type="button" class="btn tiny" onClick={() => void captureWindow()}><Camera size={12} /> Capturar la ventana</button>
            <label class="btn tiny">
              <ImagePlus size={12} /> Añadir…
              <input type="file" accept="image/*" multiple hidden onChange={(event) => { void addFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
            </label>
            <span class="muted small">o pega (Ctrl+V) o arrastra una imagen aquí</span>
          </div>
          <Show when={d().images.length}>
            <div class="report-thumbs">
              <For each={d().images}>
                {(img) => (
                  <figure class="report-thumb">
                    <img src={img.dataUrl} alt={img.name} />
                    <figcaption>
                      <button type="button" class="icon-btn" title="Marcar u ocultar partes" onClick={() => setAnnotating(img.id)}><PenLine size={13} /></button>
                      <button type="button" class="icon-btn" title="Quitar" onClick={() => removeImage(img.id)}><X size={13} /></button>
                    </figcaption>
                  </figure>
                )}
              </For>
            </div>
            <p class="muted small">Revisa que no se vean datos: «Marcar u ocultar» pixela lo que no deba verse.</p>
          </Show>
        </div>

        <Show when={d().kind === "bug"}>
          <label class="check">
            <input type="checkbox" checked={d().attachErrors} onChange={(event) => editDraft({ attachErrors: event.currentTarget.checked })} />
            Adjuntar los últimos errores del registro ({report.errors.length || "ninguno"}): se ven en la revisión antes de enviar
          </label>
        </Show>
        <p class="settings-note">
          Se añaden la versión de Celer, el sistema, el tema y el motor y driver de la conexión activa; nunca el servidor, el usuario, la base de datos ni tus
          datos. Nada sale de Celer hasta que lo revises y pulses «Abrir en GitHub». El borrador se guarda solo.
        </p>
        <footer>
          <Show when={missing().length}><span class="muted small">Falta {missing().join(", ")}.</span></Show>
          <span class="spacer" />
          <button type="button" class="btn" onClick={closeReport}>Guardar borrador y cerrar</button>
          <button type="button" class="btn primary" disabled={missing().length > 0} onClick={() => setReport("view", "preview")}>Revisar y enviar</button>
        </footer>
      </Show>
    </div>
  );
}

/** Exactly what will be sent: the title, the labels, every field as GitHub will show it, and the images. */
function ReportPreview() {
  const issue = () => currentIssue();
  const cut = () => issueUrl(issue()).cut;
  return (
    <div class="report-body">
      <p class="dialog-lead">
        Esto es exactamente lo que se enviará. «Abrir en GitHub» abre la página de un issue nuevo con estos campos ya rellenos: allí lo revisas otra vez y lo
        creas tú con tu cuenta. Las imágenes no viajan en la dirección: Celer las guarda en una carpeta (y copia la primera) para que las pegues.
      </p>
      <div class="report-preview">
        <div class="report-preview-title">{issue().title}</div>
        <div class="report-labels"><For each={issue().labels}>{(label) => <span class="tag tiny">{label}</span>}</For></div>
        <For each={issue().fields}>
          {(field) => (
            <section>
              <h4>{field.label}</h4>
              <pre>{field.value}</pre>
            </section>
          )}
        </For>
        <Show when={report.draft.images.length}>
          <section>
            <h4>Imágenes (se adjuntan a mano)</h4>
            <div class="report-thumbs"><For each={report.draft.images}>{(img) => <figure class="report-thumb"><img src={img.dataUrl} alt={img.name} /></figure>}</For></div>
          </section>
        </Show>
      </div>
      <Show when={cut().length}>
        <p class="settings-note warn">El texto es demasiado largo para la dirección: se recorta y el texto completo se copia al portapapeles para que lo pegues.</p>
      </Show>
      <footer>
        <button type="button" class="btn" onClick={() => setReport("view", "form")}>Volver a editar</button>
        <span class="spacer" />
        <button type="button" class="btn" onClick={() => void copyText(issueText(issue()), "Reporte copiado")}>Copiar texto</button>
        <button type="button" class="btn primary" onClick={() => void sendReport()}><ExternalLink size={13} /> Abrir en GitHub</button>
      </footer>
    </div>
  );
}

function ReportSent() {
  const last = () => report.last;
  const [link, setLink] = createSignal("");
  return (
    <div class="report-body">
      <p class="dialog-lead">
        Se ha abierto GitHub con el reporte relleno. Revísalo allí y pulsa <b>Submit new issue</b> (necesitas iniciar sesión en GitHub).
      </p>
      <Show when={last()?.images.length}>
        <p class="settings-note">
          {last()!.images.length === 1 ? "La imagen está" : `Las ${last()!.images.length} imágenes están`} en una carpeta de Celer
          {last()!.copied === "image" ? " y la primera, en el portapapeles: pégala (Ctrl+V) en «Capturas»." : ": arrástralas a «Capturas»."}{" "}
          <Show when={isTauri()}>
            <button type="button" class="link" onClick={() => void revealPath(last()!.images[0])}><FolderOpen size={12} /> Abrir la carpeta</button>
          </Show>
        </p>
      </Show>
      <Show when={last()?.copied === "text"}>
        <p class="settings-note warn">El texto se recortó en la dirección: el completo está en el portapapeles.</p>
      </Show>
      <label class="field">
        <span>Enlace del issue creado (opcional, para «Mis reportes»)</span>
        <input
          placeholder="https://github.com/e-omunoz/celer/issues/…"
          value={link()}
          onInput={(event) => setLink(event.currentTarget.value)}
          onChange={(event) => {
            const url = parseIssueUrl(event.currentTarget.value);
            if (url && last()) setSentLink(last()!.sent.id, url);
            else if (event.currentTarget.value.trim()) notify("No es un enlace a un issue de Celer en GitHub", "warning");
          }}
        />
      </label>
      <footer>
        <button type="button" class="btn" onClick={() => setReport("view", "mine")}>Mis reportes</button>
        <span class="spacer" />
        <button type="button" class="btn" onClick={() => void openReport(last()?.sent.kind ?? "bug")}>Otro reporte</button>
        <button type="button" class="btn primary" onClick={closeReport}>Cerrar</button>
      </footer>
    </div>
  );
}

function MyReports() {
  const [editing, setEditing] = createSignal<string | null>(null);
  return (
    <div class="report-body">
      <h4 class="report-h">Borradores</h4>
      <For each={report.drafts} fallback={<p class="muted small">No hay borradores.</p>}>
        {(d) => (
          <div class="report-row">
            <span class="report-kind-icon">{d.kind === "bug" ? <Bug size={13} /> : <Lightbulb size={13} />}</span>
            <span class="report-row-title">{d.title || "(sin título)"}</span>
            <span class="muted small">{new Date(d.updatedAt).toLocaleString()}</span>
            <button type="button" class="btn tiny" onClick={() => resumeDraft(d.id)}>Seguir</button>
            <button type="button" class="icon-btn" title="Borrar el borrador" onClick={() => deleteDraft(d.id)}><Trash2 size={13} /></button>
          </div>
        )}
      </For>
      <h4 class="report-h">Abiertos en GitHub</h4>
      <For each={report.sent} fallback={<p class="muted small">Todavía no has enviado ningún reporte.</p>}>
        {(s) => (
          <div class="report-row">
            <span class="report-kind-icon">{s.kind === "bug" ? <Bug size={13} /> : <Lightbulb size={13} />}</span>
            <span class="report-row-title">{s.title}</span>
            <span class="muted small" title={entryTime(s.at)}>{new Date(s.at).toLocaleDateString()}</span>
            <button type="button" class="btn tiny" title={s.issueUrl ? s.issueUrl : "Busca el issue por su título en GitHub"} onClick={() => void openLink(sentLink(s))}>
              <ExternalLink size={12} /> {s.issueUrl ? `#${s.issueUrl.split("/").pop()}` : "Buscar"}
            </button>
            <Show when={!s.issueUrl}>
              <Show when={editing() === s.id} fallback={<button type="button" class="link small" onClick={() => setEditing(s.id)}>Añadir enlace</button>}>
                <input
                  class="report-link-input"
                  placeholder="https://github.com/e-omunoz/celer/issues/…"
                  ref={(el) => queueMicrotask(() => el.focus())}
                  onChange={(event) => {
                    const url = parseIssueUrl(event.currentTarget.value);
                    if (url) setSentLink(s.id, url);
                    else notify("No es un enlace a un issue de Celer en GitHub", "warning");
                    setEditing(null);
                  }}
                />
              </Show>
            </Show>
            <button type="button" class="icon-btn" title="Quitar de la lista" onClick={() => forgetSent(s.id)}><Trash2 size={13} /></button>
          </div>
        )}
      </For>
      <footer>
        <span class="spacer" />
        <button type="button" class="btn" onClick={() => void openReport("idea")}><Lightbulb size={13} /> Sugerir una mejora</button>
        <button type="button" class="btn primary" onClick={() => void openReport("bug")}><Bug size={13} /> Reportar un fallo</button>
      </footer>
    </div>
  );
}

