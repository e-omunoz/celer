// Release notes as the update dialog shows them. Pure, so dev/update-check.ts can run it under node.

/** A rule (`---`, `***`, `___`), then optional blank lines and the «Download Celer X.Y.Z» heading. */
const DOWNLOAD_TAIL = /^(?:[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*\n(?:[ \t]*\n)*)?[ \t]*#{1,6}[ \t]+Download Celer\b.*$/im;

/**
 * The release body without the download section that release-desktop.yml appends (a rule, «Download Celer X.Y.Z» and
 * a table of packages): pointless in the app, which downloads the right package itself, and the renderer has no
 * tables. Everything from that section on goes; the notes above it stay as they are.
 */
export function updateNotes(body: string): string {
  const text = body.replace(/\r\n/g, "\n");
  const tail = DOWNLOAD_TAIL.exec(text);
  return (tail ? text.slice(0, tail.index) : text).trimEnd();
}
