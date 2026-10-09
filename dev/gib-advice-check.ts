// Quick checks for src/gib/advice.ts: node --experimental-strip-types dev/gib-advice-check.ts
import assert from "node:assert/strict";
import { nextTip, queryAdvice, SLOW_MS, statementKey, TIPS, type RunInfo } from "../src/gib/advice.ts";
import { defaultGibLook, gibDisplayName, gibTint, normalizeGibLook } from "../src/gib/prefs.ts";

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

console.log("gib-advice-check: all good");
