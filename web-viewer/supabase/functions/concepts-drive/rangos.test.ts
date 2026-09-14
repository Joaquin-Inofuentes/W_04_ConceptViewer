// deno test web-viewer/supabase/functions/concepts-drive/
//
// Sin dependencias: `node:assert/strict` viene con Deno, asi que estos tests
// corren sin bajar nada (el resto de la funcion tampoco importa nada externo).

import assert from "node:assert/strict";
import {
  RangoInvalido,
  aAbsoluto,
  bytesEsperados,
  formatearRango,
  parsearRango,
  totalDeContentRange,
} from "./rangos.ts";

Deno.test("sin Range no hay rango (el pedido es del archivo entero)", () => {
  assert.equal(parsearRango(null), null);
  assert.equal(parsearRango(""), null);
  assert.equal(parsearRango(undefined), null);
});

Deno.test("parsea un rango sufijo", () => {
  assert.deepEqual(parsearRango("bytes=-131072"), { tipo: "sufijo", n: 131072 });
  assert.deepEqual(parsearRango("  bytes=-1  "), { tipo: "sufijo", n: 1 });
});

Deno.test("parsea un rango absoluto, con y sin fin", () => {
  assert.deepEqual(parsearRango("bytes=0-0"), { tipo: "absoluto", desde: 0, hasta: 0 });
  assert.deepEqual(parsearRango("bytes=1024-2047"), { tipo: "absoluto", desde: 1024, hasta: 2047 });
  assert.deepEqual(parsearRango("bytes=1024-"), { tipo: "absoluto", desde: 1024, hasta: null });
});

Deno.test("un Range que no se entiende es 400, no 502", () => {
  for (const malo of ["bytes=-0", "bytes=10-5", "bytes=abc", "items=0-1", "bytes=0-9,20-29", "-131072"]) {
    assert.throws(() => parsearRango(malo), RangoInvalido, `deberia rechazar ${malo}`);
  }
});

Deno.test("sufijo -> absoluto con el total conocido", () => {
  // El caso real: los ultimos 128 KB del Submuracion.concepts de 16.338.051 B.
  const r = parsearRango("bytes=-131072")!;
  assert.deepEqual(aAbsoluto(r, 16338051), { tipo: "absoluto", desde: 16206979, hasta: 16338050 });
  assert.equal(formatearRango(aAbsoluto(r, 16338051)), "bytes=16206979-16338050");
});

Deno.test("sufijo mas grande que el archivo se recorta en 0", () => {
  const r = parsearRango("bytes=-131072")!;
  assert.deepEqual(aAbsoluto(r, 1000), { tipo: "absoluto", desde: 0, hasta: 999 });
});

Deno.test("sin total conocido el sufijo se manda tal cual", () => {
  const r = parsearRango("bytes=-131072")!;
  assert.deepEqual(aAbsoluto(r, null), r);
  assert.deepEqual(aAbsoluto(r, 0), r);
  assert.equal(formatearRango(aAbsoluto(r, null)), "bytes=-131072");
});

Deno.test("un rango que ya es absoluto no se toca", () => {
  const r = parsearRango("bytes=10-20")!;
  assert.deepEqual(aAbsoluto(r, 16338051), r);
  const abierto = parsearRango("bytes=10-")!;
  assert.deepEqual(aAbsoluto(abierto, 16338051), abierto);
  assert.equal(formatearRango(abierto), "bytes=10-");
});

Deno.test("total del Content-Range", () => {
  // El de verdad, medido contra la URL confirmada del archivo de 262 MB.
  assert.equal(totalDeContentRange("bytes 275525185-275656256/275656257"), 275656257);
  assert.equal(totalDeContentRange("bytes 0-0/16338051"), 16338051);
  // Un 416 manda `*` como total: no dice nada.
  assert.equal(totalDeContentRange("bytes */16338051"), 16338051);
  assert.equal(totalDeContentRange("bytes */*"), null);
  assert.equal(totalDeContentRange(null), null);
  assert.equal(totalDeContentRange("cualquier cosa"), null);
});

Deno.test("bytes esperados de cada forma de rango", () => {
  assert.equal(bytesEsperados(parsearRango("bytes=-131072"), 16338051), 131072);
  assert.equal(bytesEsperados(parsearRango("bytes=-131072"), 1000), 1000);
  assert.equal(bytesEsperados(parsearRango("bytes=-131072"), null), null);
  assert.equal(bytesEsperados(parsearRango("bytes=0-0"), null), 1);
  assert.equal(bytesEsperados(parsearRango("bytes=10-"), 100), 90);
  assert.equal(bytesEsperados(null, 16338051), 16338051);
});
