// Quick checks for src/gib/advice.ts: node --experimental-strip-types dev/gib-advice-check.ts
import assert from "node:assert/strict";
import { nextTip, queryAdvice, SLOW_MS, statementKey, TIPS, type RunInfo } from "../src/gib/advice.ts";
import { defaultGibLook, defaultGibPrefs, gibDisplayName, gibShownIn, gibTint, normalizeGibLook, normalizeGibPrefs } from "../src/gib/prefs.ts";
import { budgetAllows, dayKey, isFridayAfternoon, isLate, LONG_RUN_MS, LONG_SESSION_MS, pickRoutine, REACTIONS_PER_HOUR, reactionFor, spend, type ReactionContext } from "../src/gib/reactions.ts";

const run = (sql: string, extra: Partial<RunInfo> = {}) => queryAdvice({ sql, kind: "postgres", ms: 20, columns: 3, hasMore: false, ...extra })?.id ?? null;
const slow = (sql: string, extra: Partial<RunInfo> = {}) => run(sql, { ms: SLOW_MS + 1, ...extra });

// Tips: unique ids, readable text with the user's shortcuts, and a fallback when a command has none.
assert.equal(new Set(TIPS.map((t) => t.id)).size, TIPS.length, "tip ids are unique");
const KEYS: Record<string, string> = { run: "Ctrl+Intro", "save-library": "Ctrl+Alt+B", library: "Alt+8" };
const keys = (id: string) => KEYS[id] ?? "";
for (const tip of TIPS) {
  const text = tip.text(keys);
  assert.ok(text.length > 20 && !text.includes("undefined") && !/con\s*[.;]/.test(text), `tip ${tip.id}: ${text}`);
}
assert.match(TIPS.find((t) => t.id === "library")!.text(keys), /Ctrl\+Alt\+B.*Alt\+8/);
assert.match(TIPS.find((t) => t.id === "go-table")!.text(keys), /paleta/, "no shortcut: says where else to find it");
assert.match(TIPS.find((t) => t.id === "run")!.text(() => ""), /^El botón Ejecutar/);

// nextTip: unseen first, in a circle; none left when only unseen ones are wanted.
assert.equal(nextTip(0, new Set(), true)?.index, 0);
assert.equal(nextTip(0, new Set([TIPS[0].id, TIPS[1].id]), true)?.index, 2);
assert.equal(nextTip(TIPS.length - 1, new Set([TIPS[TIPS.length - 1].id]), true)?.index, 0, "wraps around");
const all = new Set(TIPS.map((t) => t.id));
assert.equal(nextTip(3, all, true), null, "every tip seen: nothing proactive");
assert.equal(nextTip(3, all, false)?.index, 3, "on demand: they come round again");
assert.equal(nextTip(-1, new Set(), false)?.index, TIPS.length - 1, "negative start");

// Likely mistakes, whatever the speed.
assert.equal(run("SELECT * FROM t WHERE a = NULL"), "eq-null");
assert.equal(run("select * from t where a<>null"), "eq-null");
assert.equal(run("SELECT * FROM t WHERE a != NULL"), "eq-null");
assert.equal(run("SELECT CASE WHEN a = NULL THEN 1 END FROM t"), "eq-null");
assert.equal(run("SELECT * FROM t WHERE a IS NULL"), null);
assert.equal(run("UPDATE t SET a = NULL WHERE id = 1"), null, "SET x = NULL is an assignment");
assert.equal(run("UPDATE t SET a = NULL, b = 2 WHERE id = 3"), null);
assert.equal(run("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = NULL"), null);
assert.equal(run("SELECT * FROM t WHERE a = 'NULL'"), null, "a string is not NULL");
assert.equal(run("SELECT * FROM t -- WHERE a = NULL\nWHERE a = 1"), null, "comments do not count");
assert.equal(run("SELECT * FROM t WHERE a >= NULL"), null, ">= is left alone");
assert.equal(run("SELECT * FROM a WHERE id NOT IN (SELECT a_id FROM b)"), "not-in-null");
assert.equal(run("SELECT * FROM a WHERE id NOT IN (1, 2)"), null);
assert.equal(run("SELECT * FROM a, b"), "cartesian");
assert.equal(run("SELECT * FROM a x, b y"), "cartesian");
assert.equal(run("SELECT * FROM a, b WHERE a.id = b.a_id"), null);
assert.equal(run("SELECT a, b FROM t ORDER BY a, b"), null, "commas after FROM elsewhere");
assert.equal(run("SELECT * FROM t LIMIT 10, 20", { kind: "mysql" }), null, "MySQL LIMIT offset, n");
assert.equal(run("SELECT * FROM a JOIN b ON a.id = b.a_id"), null);

// Performance: only when it was slow.
assert.equal(run("SELECT * FROM t WHERE name LIKE '%ana'"), null, "fast: nothing to say");
assert.equal(slow("SELECT * FROM t WHERE name LIKE '%ana'"), "like-leading");
assert.equal(slow("SELECT * FROM t WHERE name LIKE N'%ana'", { kind: "mssql" }), "like-leading");
assert.equal(slow("SELECT * FROM t WHERE name LIKE 'ana%'"), null);
assert.equal(slow("SELECT '%' FROM t WHERE x = 1 -- LIKE '%a'"), null);
assert.equal(slow("SELECT * FROM t WHERE UPPER(name) = 'ANA'"), "function-where");
assert.equal(slow("SELECT * FROM t WHERE YEAR(created) = 2024", { kind: "mysql" }), "function-where");
assert.equal(slow("SELECT UPPER(name) FROM t WHERE id = 3"), null, "a function in the SELECT list is fine");
assert.equal(slow("SELECT a FROM t UNION SELECT a FROM u"), "union-all");
assert.equal(slow("SELECT a FROM t UNION ALL SELECT a FROM u"), null);
assert.equal(slow("SELECT * FROM t ORDER BY a", { hasMore: true }), "order-limit");
assert.match(queryAdvice({ sql: "SELECT * FROM t ORDER BY a", kind: "mssql", ms: SLOW_MS, columns: 2, hasMore: true })!.text, /TOP n/);
assert.match(queryAdvice({ sql: "SELECT * FROM t ORDER BY a", kind: "informix", ms: SLOW_MS, columns: 2, hasMore: true })!.text, /FIRST n/);
assert.equal(slow("SELECT * FROM t ORDER BY a LIMIT 50", { hasMore: true }), null);
assert.equal(slow("SELECT TOP 50 * FROM t ORDER BY a", { kind: "mssql", hasMore: true }), null);
assert.equal(slow("SELECT * FROM t ORDER BY a", { hasMore: false }), null, "all rows came: nothing hidden");

// Habits.
assert.equal(run("SELECT * FROM t", { columns: 20 }), "select-star");
assert.equal(run("SELECT * FROM t", { columns: 5 }), null);
assert.equal(run("SELECT id FROM t", { columns: 20 }), null);
assert.equal(run("   "), null);
assert.equal(run("-- only a comment"), null);

// Mistakes win over performance.
assert.equal(slow("SELECT * FROM t WHERE a = NULL AND name LIKE '%x'"), "eq-null");

// The same statement however it is written.
assert.equal(statementKey("SELECT  *\nFROM t;"), statementKey("select * from t"));
assert.equal(statementKey("SELECT 1 -- note"), statementKey("select 1"));
assert.notEqual(statementKey("SELECT 1"), statementKey("SELECT 2"));

// Gib's look (Settings › Apariencia › Gib): whatever is stored becomes a valid look.
assert.deepEqual(normalizeGibLook(undefined), defaultGibLook, "missing: the default look");
assert.deepEqual(normalizeGibLook("nonsense"), defaultGibLook);
assert.deepEqual(normalizeGibLook({ color: "#3B82F6", accessories: ["scarf", "cap", "hat", "cap"], name: "  Bob   el  mono ", pose: "icon" }), {
  color: "#3b82f6",
  accessories: ["cap", "scarf"],
  name: "Bob el mono",
  pose: "icon",
}, "colour lowercased, unknown and repeated accessories dropped (in a fixed order), name tidied");
assert.equal(normalizeGibLook({ color: "red" }).color, "classic", "only #rrggbb, classic or accent");
assert.equal(normalizeGibLook({ color: "accent" }).color, "accent");
assert.equal(normalizeGibLook({ pose: "dancing" }).pose, "poker");
assert.equal(normalizeGibLook({ name: "   " }).name, "Gib", "an empty name is Gib");
assert.equal(normalizeGibLook({ name: "x".repeat(60) }).name.length, 20, "names are kept short");
assert.equal(gibDisplayName(undefined), "Gib");
assert.equal(gibDisplayName({ name: " Pepe " }), "Pepe");
assert.equal(gibTint("classic"), null, "classic: the black tie, no tint");
assert.equal(gibTint("accent"), "var(--accent)");
assert.equal(gibTint("#14b8a6"), "#14b8a6");
assert.equal(gibTint("url(x)"), null, "nothing but a colour reaches the CSS");

// Gib's presence (Settings › Apariencia › Gib), and the old "Compañero" setting read into it once.
assert.deepEqual(normalizeGibPrefs(undefined), defaultGibPrefs, "nothing stored: everything on");
assert.equal(normalizeGibPrefs(undefined, "quiet").tips, false, "Compañero: silencioso → no volunteered tips");
assert.equal(normalizeGibPrefs(undefined, "quiet").places.companion, true);
assert.equal(normalizeGibPrefs(undefined, "off").places.companion, false, "Compañero: apagado → no companion");
assert.equal(normalizeGibPrefs(undefined, "off").on, true, "…but Gib still appears elsewhere");
assert.equal(normalizeGibPrefs({ color: "accent" }, "off").places.companion, false, "a look saved before the presence settings: still migrated");
assert.equal(normalizeGibPrefs({ on: true, places: { companion: true } }, "off").places.companion, true, "once saved, the old setting is ignored");
assert.equal(normalizeGibPrefs({ on: false }).on, false);
assert.equal(normalizeGibPrefs({ on: true, frequency: "often" }).frequency, "often");
assert.equal(normalizeGibPrefs({ on: true, frequency: "always" }).frequency, "normal");
assert.equal(normalizeGibPrefs({ on: true, eyes: "no" }).eyes, true, "only booleans count");
assert.equal(normalizeGibPrefs({ on: true, places: { splash: false } }).places.splash, false);
assert.equal(normalizeGibPrefs({ on: true, places: { splash: false } }).places.empty, true);
assert.equal(gibShownIn(defaultGibPrefs, "companion"), true);
assert.equal(gibShownIn({ ...defaultGibPrefs, on: false }, "empty"), false, "off: nowhere");
assert.equal(gibShownIn({ ...defaultGibPrefs, places: { ...defaultGibPrefs.places, overlays: false } }, "overlays"), false);

// The frequency budget: at most N reactions with words per hour.
const T0 = Date.UTC(2026, 9, 7, 10);
let spent: number[] = [];
for (let i = 0; i < REACTIONS_PER_HOUR.rare; i++) {
  assert.ok(budgetAllows(spent, T0 + i * 1000, "rare"), `reaction ${i + 1} fits`);
  spent = spend(spent, T0 + i * 1000);
}
assert.equal(budgetAllows(spent, T0 + 10_000, "rare"), false, "budget spent");
assert.equal(budgetAllows(spent, T0 + 10_000, "often"), true, "a larger budget");
assert.equal(budgetAllows(spent, T0 + 61 * 60_000, "rare"), true, "an hour later it is back");
assert.equal(spend(spent, T0 + 61 * 60_000).length, 1, "old entries are dropped");
assert.ok(REACTIONS_PER_HOUR.rare < REACTIONS_PER_HOUR.normal && REACTIONS_PER_HOUR.normal < REACTIONS_PER_HOUR.often);

// Idle activities: never one of the last few; the coffee break less often than the rest.
const NAMES = ["yawn", "coffee", "laptop", "doze", "juggle"];
for (let i = 0; i < 50; i++) assert.ok(!["yawn", "doze"].includes(pickRoutine(NAMES, ["yawn", "doze"])), "recent ones are skipped");
assert.equal(pickRoutine(NAMES, NAMES, () => 0), "yawn", "all recent: any");
const counts: Record<string, number> = {};
for (let i = 0; i < 1000; i++) {
  const name = pickRoutine(NAMES, [], () => i / 1000);
  counts[name] = (counts[name] ?? 0) + 1;
}
assert.ok(counts.coffee < counts.yawn, "the coffee break is rarer");

// Reactions to real events.
const wednesday = new Date(2026, 9, 7, 11, 0);
const ctx = (extra: Partial<ReactionContext> = {}): ReactionContext => ({
  now: wednesday,
  name: "Gib",
  said: new Set(),
  lastQueryDay: dayKey(wednesday),
  sessionMs: 10 * 60_000,
  formatMs: (ms) => `${Math.round(ms / 1000)} s`,
  ...extra,
});
const ok = (extra: object = {}) => ({ type: "query-ok" as const, ms: 40, rows: 3, empty: false, ...extra });
assert.equal(reactionFor(ok(), ctx()), null, "an ordinary query: nothing to say");
assert.equal(reactionFor(ok(), ctx({ lastQueryDay: "2026-10-06" }))?.id, "first-today");
assert.match(reactionFor(ok(), ctx({ lastQueryDay: "" }))!.text!, /Buenos días/);
assert.equal(reactionFor(ok(), ctx({ lastQueryDay: "2026-10-06", said: new Set(["first:2026-10-07"]) })), null, "said once a day");
assert.equal(reactionFor(ok({ ms: LONG_RUN_MS }), ctx())?.id, "long-success");
assert.match(reactionFor(ok({ ms: 25_000 }), ctx())!.text!, /25 s/);
assert.equal(reactionFor(ok({ empty: true, rows: 0 }), ctx())?.id, "empty");
assert.equal(reactionFor(ok({ empty: true }), ctx())?.activity, "scratch");
assert.equal(reactionFor({ type: "query-error", streak: 1 }, ctx())?.text, undefined, "one error: a face, no words");
assert.equal(reactionFor({ type: "query-error", streak: 3 }, ctx())?.id, "error-streak");
assert.equal(reactionFor({ type: "export-done", rows: 120, ms: 300 }, ctx())?.text, undefined, "a small export: a nod");
assert.match(reactionFor({ type: "export-done", rows: 80_000, ms: 4000 }, ctx())!.text!, /80\.000 filas/);
assert.equal(reactionFor({ type: "export-done", rows: 10, ms: 20_000 }, ctx())?.id, "export-done");
assert.match(reactionFor({ type: "conn-lost", name: "Ventas" }, ctx())!.text!, /«Ventas»/);
assert.equal(reactionFor({ type: "conn-lost", name: "Ventas" }, ctx())?.kind, "warn");
assert.match(reactionFor({ type: "conn-back", name: "Ventas" }, ctx({ name: "Bob" }))!.text!, /Bob/, "his own name");
const friday = new Date(2026, 9, 9, 16, 30);
assert.ok(isFridayAfternoon(friday) && !isFridayAfternoon(wednesday) && !isFridayAfternoon(new Date(2026, 9, 9, 10)));
assert.equal(reactionFor(ok(), ctx({ now: friday, lastQueryDay: dayKey(friday) }))?.id, "friday");
assert.equal(reactionFor(ok({ production: true }), ctx({ now: friday, lastQueryDay: dayKey(friday) }))?.kind, "warn", "Friday and production: careful");
assert.equal(reactionFor(ok(), ctx({ now: friday, lastQueryDay: dayKey(friday), said: new Set(["friday:2026-10-09"]) })), null);
const late = new Date(2026, 9, 8, 1, 15);
assert.ok(isLate(late) && isLate(new Date(2026, 9, 7, 23)) && !isLate(wednesday));
assert.equal(reactionFor(ok(), ctx({ now: late, lastQueryDay: dayKey(late) }))?.once, "late:2026-10-07", "after midnight it is still the evening before");
assert.equal(reactionFor(ok(), ctx({ sessionMs: LONG_SESSION_MS + 1 }))?.id, "long-session");
assert.equal(reactionFor(ok(), ctx({ sessionMs: LONG_SESSION_MS + 1, said: new Set(["session:1"]) })), null, "once per two hours");
assert.equal(reactionFor(ok(), ctx({ sessionMs: 2 * LONG_SESSION_MS + 1, said: new Set(["session:1"]) }))?.once, "session:2");
// Priority: the first query of the day wins over a slow one (the rest wait).
assert.equal(reactionFor(ok({ ms: LONG_RUN_MS }), ctx({ lastQueryDay: "" }))?.id, "first-today");

console.log("gib-advice-check: all good");
