// Checks for src/keymap.ts: node --experimental-strip-types dev/keymap-check.ts
import assert from "node:assert/strict";
import { chordLabel, chordOf, chordParts, chordsFor, codeMirrorKey, DEFAULT_KEYS, normalizeChord } from "../src/keymap.ts";

const ev = (key: string, code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; altGraph?: boolean } = {}) => ({
  key,
  code,
  ctrlKey: Boolean(mods.ctrl),
  metaKey: Boolean(mods.meta),
  altKey: Boolean(mods.alt),
  shiftKey: Boolean(mods.shift),
  getModifierState: (k: string) => k === "AltGraph" && Boolean(mods.altGraph),
});

// Letters, digits and named keys.
assert.equal(chordOf(ev("e", "KeyE", { ctrl: true, shift: true })), "Ctrl+Shift+E");
assert.equal(chordOf(ev("E", "KeyE", { ctrl: true, shift: true })), "Ctrl+Shift+E");
assert.equal(chordOf(ev("Enter", "Enter", { ctrl: true })), "Ctrl+Enter");
assert.equal(chordOf(ev("Enter", "NumpadEnter", { ctrl: true, shift: true })), "Ctrl+Shift+Enter");
assert.equal(chordOf(ev("F5", "F5")), "F5");
assert.equal(chordOf(ev("1", "Digit1", { alt: true })), "Alt+1");
assert.equal(chordOf(ev("b", "KeyB", { meta: true, alt: true })), "Ctrl+Alt+B", "Cmd counts as Ctrl");
assert.equal(chordOf(ev("Tab", "Tab", { ctrl: true, shift: true })), "Ctrl+Shift+Tab");
// Shift+1 gives "!": still the 1 key.
assert.equal(chordOf(ev("!", "Digit1", { ctrl: true, shift: true })), "Ctrl+Shift+1");
// Symbols: the Shift that produces them is not part of the shortcut.
assert.equal(chordOf(ev("+", "Equal", { ctrl: true, shift: true })), "Ctrl++", "US keyboard: Shift+= is +");
assert.equal(chordOf(ev("+", "BracketRight", { ctrl: true })), "Ctrl++", "Spanish keyboard");
assert.equal(chordOf(ev("-", "Slash", { ctrl: true })), "Ctrl+-");
// Another alphabet: the key's position.
assert.equal(chordOf(ev("у", "KeyE", { ctrl: true, alt: true })), "Ctrl+Alt+E");
// Not shortcuts: lone modifiers and AltGr characters (AltGr+E is "€" on a Spanish keyboard).
assert.equal(chordOf(ev("Control", "ControlLeft", { ctrl: true })), null);
assert.equal(chordOf(ev("Shift", "ShiftLeft", { shift: true })), null);
assert.equal(chordOf(ev("€", "KeyE", { ctrl: true, alt: true })), null);
assert.equal(chordOf(ev("@", "Digit2", { ctrl: true, alt: true })), null);
assert.equal(chordOf(ev("e", "KeyE", { ctrl: true, alt: true, altGraph: true })), null);

// Normalization of hand-written or stored chords.
assert.equal(normalizeChord("ctrl+shift+e"), "Ctrl+Shift+E");
assert.equal(normalizeChord("Mod+Intro"), "Ctrl+Enter");
assert.equal(normalizeChord("Ctrl++"), "Ctrl++");
assert.equal(normalizeChord("alt+x"), "Alt+X");
assert.equal(normalizeChord("f5"), "F5");
assert.equal(normalizeChord("Ctrl+espacio"), "Ctrl+Space");

// The user's list replaces the defaults; an empty list removes the shortcut; other commands keep theirs.
assert.deepEqual(chordsFor("run", {}), ["Ctrl+Enter"]);
assert.deepEqual(chordsFor("run", { run: ["ctrl+r"] }), ["Ctrl+R"]);
assert.deepEqual(chordsFor("run", { run: [] }), []);
assert.deepEqual(chordsFor("save", { run: [] }), DEFAULT_KEYS.save);
assert.deepEqual(chordsFor("library", {}), []);

// Display and CodeMirror notation.
assert.deepEqual(chordParts("Ctrl+Shift+Enter"), ["Ctrl", "Mayús", "Intro"]);
assert.deepEqual(chordParts("Ctrl++"), ["Ctrl", "+"]);
assert.equal(chordLabel("Ctrl+Alt+Shift+C"), "Ctrl+Alt+Mayús+C");
assert.equal(codeMirrorKey("Ctrl+Shift+Enter"), "Mod-Shift-Enter");
assert.equal(codeMirrorKey("Ctrl+Alt+L"), "Mod-Alt-l");
assert.equal(codeMirrorKey("Alt+X"), "Alt-x");
assert.equal(codeMirrorKey("Ctrl++"), "Mod-+");
assert.equal(codeMirrorKey("F9"), "F9");

// No default chord is used twice.
const seen = new Map<string, string>();
for (const [id, keys] of Object.entries(DEFAULT_KEYS)) {
  for (const k of keys) {
    assert.ok(!seen.has(k), `${k} is the default of both ${seen.get(k)} and ${id}`);
    seen.set(k, id);
    assert.equal(normalizeChord(k), k, `default ${k} is normalized`);
  }
}

console.log("keymap-check: all good");
