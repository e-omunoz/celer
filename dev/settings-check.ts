// Checks for the settings (src/settingsSections.ts, src/cellFormat.ts): node --experimental-strip-types dev/settings-check.ts
import assert from "node:assert/strict";
import { cellLabel, formatDate, formatNumber } from "../src/cellFormat.ts";
import { formatSql } from "../src/sql.ts";
import {
  clampSetting,
  exportSettings,
  INTERNAL_SETTINGS,
  parseSettingsFile,
  resetPatch,
  searchSettings,
  SETTINGS_FILE_FORMAT,
  SETTINGS_SECTIONS,
} from "../src/settingsSections.ts";
import { defaultSettings, type Settings } from "../src/types.ts";

// ---- every setting has a home: a section (reset, search) or the app's own bookkeeping
const owned = new Map<string, string>();
for (const section of SETTINGS_SECTIONS) {
  for (const key of section.keys) {
    assert.ok(!owned.has(key), `${key} is in two sections (${owned.get(key)}, ${section.id})`);
    owned.set(key, section.id);
  }
  assert.ok(section.items.length, `${section.id} lists its settings for the search box`);
}
for (const key of Object.keys(defaultSettings)) {
  assert.ok(owned.has(key) || INTERNAL_SETTINGS.includes(key as keyof Settings), `${key} belongs to no section`);
}
assert.equal(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size, SETTINGS_SECTIONS.length, "section ids are unique");

// ---- an old settings file (before these settings existed) loads unchanged, new keys at their defaults
const old = { theme: "fjord", accent: "#3B82F6", pageSize: 1000, zebra: false, keymap: { run: ["Ctrl+Enter"] } };
const loaded: Settings = { ...defaultSettings, ...(old as Partial<Settings>) };
assert.equal(loaded.theme, "fjord");
assert.equal(loaded.pageSize, 1000);
assert.equal(loaded.zebra, false);
assert.equal(loaded.queryTimeout, 0, "no timeout unless chosen");
assert.equal(loaded.autocommitDefault, true, "consoles keep starting in auto-commit");
assert.equal(loaded.restoreSession, true, "tabs keep coming back");
assert.equal(loaded.tableTabs, "reuse", "a table keeps opening in its own tab");
assert.equal(loaded.nullText, "NULL");
assert.equal(loaded.maxCellChars, 400, "the grid kept 400 characters per cell");
assert.equal(loaded.copyFormat, "tsv", "Ctrl+C kept copying TSV");
assert.equal(loaded.toastSeconds, 4.5, "notices kept their 4.5 s");
assert.equal(loaded.historyMax, 5000, "the core kept 5000 queries");

// ---- search: words in any order, accents and case aside, also by section name
const labels = (q: string) => searchSettings(q).map((m) => `${m.section}:${m.label}`);
assert.ok(labels("tiempo maximo").includes("execution:Tiempo máximo de una consulta"));
assert.ok(labels("TIMEOUT").includes("execution:Timeout"));
assert.ok(labels("null").includes("results:Texto de NULL"));
assert.ok(labels("historial vaciar").includes("history:Vaciar historial"));
assert.ok(labels("letra editor").includes("editor:Tipo de letra del editor"));
assert.deepEqual(labels(""), []);
assert.deepEqual(labels("zzzz-nada"), []);

// ---- «Restablecer sección»: only that section's keys, at their defaults (copies, not shared arrays)
const results = SETTINGS_SECTIONS.find((s) => s.id === "results")!;
const patch = resetPatch(results);
assert.deepEqual(Object.keys(patch).sort(), [...results.keys].sort());
assert.equal(patch.nullText, "NULL");
const templates = resetPatch(SETTINGS_SECTIONS.find((s) => s.id === "templates")!);
assert.deepEqual(templates.snippets, []);
assert.notEqual(templates.snippets, defaultSettings.snippets, "a fresh array, so editing it never changes the defaults");

// ---- ranges
assert.equal(clampSetting("queryTimeout", -5), 0);
assert.equal(clampSetting("queryTimeout", 30), 30);
assert.equal(clampSetting("historyMax", 5), 100);
assert.equal(clampSetting("maxCellChars", 1e9), 10_000);
assert.equal(clampSetting("toastSeconds", Number.NaN), 4.5);
assert.equal(clampSetting("toastSeconds", "7"), 4.5, "text is not a number");

// ---- export / import round trip
const mine: Settings = { ...defaultSettings, theme: "sand", queryTimeout: 60, nullText: "∅", favoriteConns: ["abc"], recentConns: [{ id: "abc", at: 1 }], onboarded: true };
const file = exportSettings(mine, "2.3.0", new Date("2026-10-09T10:00:00Z"));
const parsed = JSON.parse(file);
assert.equal(parsed.format, SETTINGS_FILE_FORMAT);
assert.equal(parsed.app, "2.3.0");
assert.equal(parsed.settings.favoriteConns, undefined, "favourites point at this machine's connections");
assert.equal(parsed.settings.onboarded, undefined);
const back = parseSettingsFile(file);
assert.equal(back.patch.theme, "sand");
assert.equal(back.patch.queryTimeout, 60);
assert.equal(back.patch.nullText, "∅");
assert.deepEqual(back.ignored, []);
// A bare settings object (settings.json itself) works too; unknown keys, wrong types and bad values are reported.
const loose = parseSettingsFile(JSON.stringify({ theme: "neon", pageSize: "500", zebra: false, future: 1, historyDays: 99999, snippets: [{ name: "x", body: "SELECT 1" }, { bad: true }], keymap: { run: ["Ctrl+Enter"], bad: [1] }, recentConns: [] }));
assert.deepEqual(loose.patch.zebra, false);
assert.equal(loose.patch.historyDays, 3650, "brought into range");
assert.deepEqual(loose.patch.snippets, [{ name: "x", description: "", body: "SELECT 1" }]);
assert.deepEqual(loose.patch.keymap, { run: ["Ctrl+Enter"] });
assert.deepEqual(loose.ignored.sort(), ["future", "pageSize", "recentConns", "theme"]);
assert.throws(() => parseSettingsFile("no es json"), /JSON/);
assert.throws(() => parseSettingsFile("[1,2]"), /ajustes/);

// ---- how the grid shows values
const prefs = { nullText: "NULL", dateFormat: "iso" as const, numberFormat: "plain" as const, maxCellChars: 400 };
assert.equal(cellLabel(null, "text", prefs), "NULL");
assert.equal(cellLabel(null, "text", { ...prefs, nullText: "" }), "");
assert.equal(cellLabel(null, "number", { ...prefs, nullText: "(nulo)" }), "(nulo)");
assert.equal(cellLabel(true, "bool", prefs), "true");
assert.equal(cellLabel("abcdef", "text", { ...prefs, maxCellChars: 3 }), "abc…");
assert.equal(formatDate("2026-03-15", "dmy"), "15/03/2026");
assert.equal(formatDate("2026-03-15 10:20:00", "dmy"), "15/03/2026 10:20:00");
assert.equal(formatDate("2026-03-15T10:20:00.123+01:00", "dmy"), "15/03/2026 10:20:00.123+01:00");
assert.equal(formatDate("10:20:00", "dmy"), "10:20:00", "a time alone stays");
assert.equal(formatDate("2026-03-15", "iso"), "2026-03-15");
assert.equal(formatNumber("1234567.5", "grouped"), "1.234.567,5");
assert.equal(formatNumber("-1234", "grouped"), "-1.234");
assert.equal(formatNumber("123", "grouped"), "123");
assert.equal(formatNumber("12345678901234567890.123456789", "grouped"), "12.345.678.901.234.567.890,123456789", "a wide DECIMAL keeps every digit");
assert.equal(formatNumber("1e21", "grouped"), "1e21");
assert.equal(formatNumber("1234.5", "plain"), "1234.5");
assert.equal(cellLabel(1234567, "number", { ...prefs, numberFormat: "grouped" }), "1.234.567");
assert.equal(cellLabel("2026-03-15", "text", { ...prefs, dateFormat: "dmy" }), "2026-03-15", "only date columns");

// ---- keyword case of «Formatear SQL»
assert.equal(formatSql("select a from t where x = 1", "postgres", "lower"), "select a\nfrom t\nwhere x = 1");
assert.equal(formatSql("select a from t where x = 1", "postgres"), "SELECT a\nFROM t\nWHERE x = 1");

console.log("settings-check: ok");
