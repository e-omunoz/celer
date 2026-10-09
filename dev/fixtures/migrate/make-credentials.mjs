// Writes the DBeaver credentials-config.json of the sample workspace (dev/fixtures/migrate): the users and passwords of
// the engines in dev/wsl/compose.yml, encrypted as DBeaver does (AES-128-CBC with its public default key, IV first).
//   node dev/fixtures/migrate/make-credentials.mjs
import { writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const credentials = {
  "postgres-jdbc-18f2a1c9d10-5a1b2c3d4e5f6071": { "#connection": { user: "celer", password: "celer" } },
  "mysql8-18f2a1ca0aa-6b7c8d9e0f1a2b3c": { "#connection": { user: "celer", password: "celer" } },
  "mariaDB-18f2a1cb1bb-7c8d9e0f1a2b3c4d": { "#connection": { user: "celer", password: "celer" } },
  "microsoft-18f2a1cc2cc-8d9e0f1a2b3c4d5e": { "#connection": { user: "sa", password: "Celer_Test_2026!" } },
  "informix-18f2a1cd3dd-9e0f1a2b3c4d5e6f": { "#connection": { user: "informix", password: "in4mix" } },
  "db2_iseries-18f2a1ce4ee-0f1a2b3c4d5e6f70": { "#connection": { user: "informix", password: "in4mix" } },
  "odbc-18f2a1d0600-2b3c4d5e6f708192": { "#connection": { user: "celer", password: "celer" } },
  "postgres-ssh-18f2a1d1711-3c4d5e6f70819203": {
    "#connection": { user: "celer", password: "celer" },
    "network/ssh_tunnel": { user: "celer", password: "celer" },
  },
};

const hex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const key = await crypto.subtle.importKey("raw", hex("babb4a9f774ab853c96c2d653dfe544a"), { name: "AES-CBC" }, false, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(16));
const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new TextEncoder().encode(JSON.stringify(credentials))));
const out = new URL("./DBeaverData/workspace6/General/.dbeaver/credentials-config.json", import.meta.url);
writeFileSync(out, Buffer.concat([Buffer.from(iv), Buffer.from(data)]));
console.log(`written ${out.pathname}`);
