// Quick checks for src/aiError.ts (the server error sent to the in-app AI): node --experimental-strip-types dev/aierror-check.ts
import assert from "node:assert/strict";
import { errorForAi, OMITTED } from "../src/aiError.ts";

const secret = /alice@example\.com|\$2b\$secret|-1\)/;
const sent = (error: string) => errorForAi(error, false);

// PostgreSQL as Celer formats it: the DETAIL line carries the whole failing row or the key's value.
const check = 'ERROR 23514: new row for relation "users" violates check constraint "users_salary_check"\nDetalle: Failing row contains (1, alice@example.com, $2b$secret, -1).\nSugerencia: x';
let r = sent(check);
assert.equal(r.text, 'ERROR 23514: new row for relation "users" violates check constraint "users_salary_check"\nSugerencia: x');
assert.ok(r.redacted);
r = sent('ERROR 23505: duplicate key value violates unique constraint "users_email_key"\nDetalle: Key (email)=(alice@example.com) already exists.\nPosición: línea 1, columna 8\nContexto: SQL statement "UPDATE users SET email = \'alice@example.com\'"');
assert.equal(r.text, 'ERROR 23505: duplicate key value violates unique constraint "users_email_key"\nPosición: línea 1, columna 8');
assert.doesNotMatch(sent('ERROR 22P02: invalid input syntax for type integer: "$2b$secret"').text, secret);
assert.match(sent('ERROR 22P02: invalid input syntax for type integer: "$2b$secret"').text, /integer: "«valor omitido»"/);
assert.doesNotMatch(sent("ERROR 22P02: la sintaxis de entrada no es válida para tipo integer: «$2b$secret»").text, secret);
// Through ODBC or another driver the DETAIL can come inline, in English.
r = sent('ERROR: duplicate key value violates unique constraint "u"; DETAIL: Key (email)=(alice@example.com) already exists.');
assert.doesNotMatch(r.text, secret);
assert.equal(sent("Key (a, b)=(alice@example.com, (x)) is not present").text, `Key (a, b)=(${OMITTED}) is not present`);
assert.equal(sent("Failing row contains (1, alice@example.com, $2b$secret, -1).").text, `Failing row contains (${OMITTED}).`);

// MySQL and MariaDB.
assert.equal(sent("1062 (23000): Duplicate entry 'alice@example.com' for key 'users.email'").text, `1062 (23000): Duplicate entry '${OMITTED}' for key 'users.email'`);
assert.equal(sent("Duplicate entry 'it's' for key 'email'").text, `Duplicate entry '${OMITTED}' for key 'email'`);
assert.doesNotMatch(sent("1292: Truncated incorrect DOUBLE value: '$2b$secret'").text, secret);
assert.equal(sent("1366: Incorrect integer value: '$2b$secret' for column 'n' at row 1").text, `1366: Incorrect integer value: '${OMITTED}' for column 'n' at row 1`);

// SQL Server.
r = sent("Violation of UNIQUE KEY constraint 'UQ_users'. Cannot insert duplicate key in object 'dbo.users'. The duplicate key value is (alice@example.com).");
assert.equal(r.text, `Violation of UNIQUE KEY constraint 'UQ_users'. Cannot insert duplicate key in object 'dbo.users'. The duplicate key value is (${OMITTED}).`);
assert.equal(sent("Conversion failed when converting the varchar value '$2b$secret' to data type int.").text, `Conversion failed when converting the varchar value '${OMITTED}' to data type int.`);
assert.doesNotMatch(sent("String or binary data would be truncated in table 'd.dbo.users', column 'email'. Truncated value: 'alice@example.com'.").text, secret);

// Errors without values pass unchanged, and nothing is touched when the connection lets the AI read data.
r = sent('ERROR 42703: column "nmae" does not exist\nSugerencia: Perhaps you meant "name".');
assert.deepEqual(r, { text: 'ERROR 42703: column "nmae" does not exist\nSugerencia: Perhaps you meant "name".', redacted: false });
assert.deepEqual(errorForAi(check, true), { text: check, redacted: false });

console.log("aierror-check: ok");
