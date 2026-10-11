// Checks for src/environment.ts (connection environments): node --experimental-strip-types dev/environment-check.ts
import assert from "node:assert/strict";
import { CUSTOM_ENV_COLOR, ENVIRONMENTS, envIdOf, envOf, envPatch, envSuggestions, normalizeEnvironment, shortLabel } from "../src/environment.ts";
import { contrastRatio } from "../src/contrast.ts";

// A connection saved before environments: the production flag is Producción, the rest have none.
assert.equal(envIdOf({ production: true }), "prod");
assert.equal(envIdOf({ production: false }), "");
assert.equal(envOf({ production: false }), null);
assert.deepEqual(normalizeEnvironment({ production: true }), { production: true, environment: "prod" });
const untouched = { production: false };
assert.equal(normalizeEnvironment(untouched), untouched, "nothing to change: the same object");
// The built-in environments decide the flag; a custom one keeps the user's.
assert.equal(normalizeEnvironment({ production: false, environment: "prod" }).production, true);
assert.equal(normalizeEnvironment({ production: true, environment: "staging" }).production, false);
assert.equal(normalizeEnvironment({ production: true, environment: "custom" }).production, true);
// An environment of a later version: the flag decides how it looks.
assert.equal(envIdOf({ production: true, environment: "qa-2" }), "prod");

// How each looks: tokens for the built-in ones (themes and high contrast define them), production red.
for (const env of ENVIRONMENTS) {
  const look = envOf({ production: env.id === "prod", environment: env.id })!;
  assert.equal(look.label, env.label);
  assert.equal(look.color, `var(--env-${env.id})`);
  assert.equal(look.fg, `var(--env-${env.id}-fg)`);
  assert.equal(look.production, env.id === "prod");
}
assert.deepEqual(ENVIRONMENTS.map((env) => env.label), ["Desarrollo", "Pruebas", "Preproducción", "Producción"]);
// Custom: the user's name and colour, a readable label on it, a fallback for both.
let custom = envOf({ production: false, environment: "custom", envLabel: "Cliente Egarsat", envColor: "#D4A72C" })!;
assert.equal(custom.label, "Cliente Egarsat");
assert.equal(custom.short, "CLIENTE EGA…");
assert.equal(custom.color, "#D4A72C");
assert.ok(contrastRatio(custom.color, custom.fg) >= 4.5, `custom label at ${contrastRatio(custom.color, custom.fg)}`);
custom = envOf({ production: true, environment: "custom", envLabel: " ", envColor: "red" })!;
assert.equal(custom.label, "Personalizado");
assert.equal(custom.color, CUSTOM_ENV_COLOR);
assert.equal(custom.production, true);
for (const color of ["#000000", "#ffffff", "#777777", "#E5534B", "#2BA3A3", "#986EE2"]) {
  const look = envOf({ production: false, environment: "custom", envColor: color })!;
  assert.ok(contrastRatio(look.color, look.fg) >= 4.5, `${color}: label at ${contrastRatio(look.color, look.fg).toFixed(2)}`);
}
assert.equal(shortLabel(" qa "), "QA");

// Picking one in the form.
assert.deepEqual(envPatch("prod", { production: false }), { environment: "prod", production: true });
assert.deepEqual(envPatch("dev", { production: true, environment: "prod" }), { environment: "dev", production: false });
assert.deepEqual(envPatch("custom", { production: true, environment: "prod" }), { environment: "custom", production: false });
assert.deepEqual(envPatch("custom", { production: true, environment: "custom" }), { environment: "custom", production: true });
assert.deepEqual(envPatch("", { production: true, environment: "prod" }), { environment: "", production: false });

// What it suggests: production asks for read-only (unless it is) and explains the stricter warnings.
assert.equal(envSuggestions({ production: true, environment: "prod", readOnly: false }).length, 2);
assert.equal(envSuggestions({ production: true, environment: "prod", readOnly: true }).length, 1);
assert.equal(envSuggestions({ production: false, environment: "staging", readOnly: false }).length, 1);
assert.deepEqual(envSuggestions({ production: false, environment: "dev", readOnly: false }), []);

console.log("environment-check: ok");
