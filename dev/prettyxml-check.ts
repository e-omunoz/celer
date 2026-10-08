// Checks for src/prettyXml.ts: node --experimental-strip-types dev/prettyxml-check.ts
import assert from "node:assert/strict";
import { prettyXml } from "../src/prettyXml.ts";

assert.equal(
  prettyXml('<?xml version="1.0"?><pedido id="7"><cliente>Ana</cliente><lineas><linea sku="A" uds="2"/><linea sku="B" uds="1"/></lineas></pedido>'),
  ['<?xml version="1.0"?>', '<pedido id="7">', "  <cliente>Ana</cliente>", "  <lineas>", '    <linea sku="A" uds="2"/>', '    <linea sku="B" uds="1"/>', "  </lineas>", "</pedido>"].join("\n"),
);
// Already indented: the same layout, not doubled blank lines.
assert.equal(prettyXml("<a>\n  <b>1</b>\n</a>"), "<a>\n  <b>1</b>\n</a>");
// Comments, CDATA and mixed text stay.
assert.equal(prettyXml("<a><!-- nota --><b><![CDATA[x < y]]></b>texto<c/></a>"), "<a>\n  <!-- nota -->\n  <b>\n    <![CDATA[x < y]]>\n  </b>\n  texto\n  <c/>\n</a>");
// A fragment of several elements (SQL Server FOR XML without a root).
assert.equal(prettyXml("<r id=\"1\"/><r id=\"2\"/>"), '<r id="1"/>\n<r id="2"/>');
// Namespaces and accented names.
assert.equal(prettyXml("<soap:Envelope><soap:Body><año>2024</año></soap:Body></soap:Envelope>"), "<soap:Envelope>\n  <soap:Body>\n    <año>2024</año>\n  </soap:Body>\n</soap:Envelope>");
// Not XML: null (the viewer shows the text as it is).
assert.equal(prettyXml("hola"), null);
assert.equal(prettyXml("<a><b></a></b>"), null, "badly nested");
assert.equal(prettyXml("<a>"), null, "not closed");
assert.equal(prettyXml("< 3 and > 2"), null);
assert.equal(prettyXml("<!-- solo un comentario -->"), null, "no element");
assert.equal(prettyXml('{"a": "<b>"}'), null);
console.log("prettyxml-check: all good");
