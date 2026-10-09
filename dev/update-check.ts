// Checks for src/updateNotes.ts: node --experimental-strip-types dev/update-check.ts
import assert from "node:assert/strict";
import { updateNotes } from "../src/updateNotes.ts";

const DL = "https://github.com/e-omunoz/celer/releases/download/v2.1.1";
// The tail release-desktop.yml appends to every release body.
const tail = [
  "",
  "---",
  "### Download Celer 2.1.1",
  "",
  "| System | Package |",
  "|---|---|",
  `| **Windows** | [Celer-Setup-Windows.exe](${DL}/Celer-Setup-Windows.exe): installs for your user · portable: [Celer-Portable-Windows.exe](${DL}/Celer-Portable-Windows.exe) |`,
  `| **macOS** | [Celer-macOS.dmg](${DL}/Celer-macOS.dmg) (Apple silicon and Intel) |`,
  "",
  `The packages are not code-signed. Verify any download with [SHA256SUMS.txt](${DL}/SHA256SUMS.txt) (see SECURITY.md).`,
  "",
].join("\n");
const notes = "### Fixed\n- **Informix over JDBC** failed at once.\n  Java's own messages now go to its error output.";

assert.equal(updateNotes(notes + "\n" + tail), notes);
// Windows line endings, as GitHub may return the body.
assert.equal(updateNotes((notes + "\n" + tail).replace(/\n/g, "\r\n")), notes);
// A blank line between the rule and the heading, another rule style, another heading level.
assert.equal(updateNotes(`${notes}\n\n***\n\n## Download Celer 2.0.1\n\n| System | Package |\n|---|---|`), notes);
// The heading alone, without the rule.
assert.equal(updateNotes(`${notes}\n\n### Download Celer 1.9.0\n| a | b |`), notes);
// No download section: the notes as they are, rules included.
assert.equal(updateNotes(notes), notes);
assert.equal(updateNotes(`### Added\n- Uno\n\n---\n\n### Fixed\n- Dos\n`), "### Added\n- Uno\n\n---\n\n### Fixed\n- Dos");
// Only a heading that starts with «Download Celer» counts, not a mention of it.
assert.equal(updateNotes("- The Download Celer section is shorter."), "- The Download Celer section is shorter.");
// Nothing but the download section: nothing to show.
assert.equal(updateNotes(tail.trimStart()), "");
assert.equal(updateNotes(""), "");

console.log("update-check: all good");
