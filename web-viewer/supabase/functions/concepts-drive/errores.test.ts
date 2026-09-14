// deno test web-viewer/supabase/functions/concepts-drive/

import assert from "node:assert/strict";
import {
  CODIGO_EDGE,
  CODIGO_RANGO,
  ErrorProxy,
  comoErrorProxy,
  cuerpoDeError,
  nuevoIdFallo,
} from "./errores.ts";

const CTX = { fileId: "1wvPzM2G0m-2CCC33aDEQqEQnNSCLDeib", range: "bytes=-131072", id: "deadbeef" };

Deno.test("el archivo que ya no esta en Drive es 404 con causa drive-404", () => {
  const err = new ErrorProxy(404, "drive-404", { upstreamStatus: 404, detalle: "Drive no tiene ese archivo (404)." });
  const cuerpo = cuerpoDeError(err, CTX);
  assert.equal(err.estado, 404);
  assert.equal(cuerpo.codigo, CODIGO_EDGE);
  assert.equal(cuerpo.causa, "drive-404");
  assert.equal(cuerpo.upstreamStatus, 404);
  assert.equal(cuerpo.fileId, CTX.fileId);
  assert.equal(cuerpo.range, "bytes=-131072");
  assert.equal(cuerpo.id, "deadbeef");
  assert.equal(cuerpo.ok, false);
});

Deno.test("un rango que el upstream no honro es 416 + UNX-F4005", () => {
  const err = new ErrorProxy(416, "drive-sin-rangos", { upstreamStatus: 200, detalle: "Drive contesto 200" });
  assert.equal(err.estado, 416);
  // El codigo de rango sale solo por la causa: es el que el cliente mira para
  // caer a la descarga completa a proposito.
  assert.equal(err.codigo, CODIGO_RANGO);
  assert.equal(cuerpoDeError(err, CTX).causa, "drive-sin-rangos");
});

Deno.test("un pedido invalido es 400, no 502", () => {
  const err = new ErrorProxy(400, "pedido-invalido", { detalle: "fileId invalido" });
  assert.equal(err.estado, 400);
  assert.equal(err.codigo, CODIGO_EDGE);
  assert.equal(cuerpoDeError(err, CTX).detalle, "fileId invalido");
});

Deno.test("un timeout se distingue de un error cualquiera", () => {
  const dom = new DOMException("Signal timed out.", "TimeoutError");
  assert.equal(comoErrorProxy(dom).causa, "timeout");
  assert.equal(comoErrorProxy(dom).estado, 502);
  const abortado = new DOMException("The signal has been aborted", "AbortError");
  assert.equal(comoErrorProxy(abortado).causa, "timeout");
});

Deno.test("cualquier otra cosa cae en interno, sin perder el mensaje", () => {
  const err = comoErrorProxy(new TypeError("x.y is not a function"));
  assert.equal(err.causa, "interno");
  assert.equal(err.estado, 502);
  assert.match(err.detalle, /TypeError: x\.y is not a function/);
  // Un valor que ni siquiera es Error tampoco tiene que tirar.
  assert.equal(comoErrorProxy({ raro: true }).causa, "interno");
});

Deno.test("un ErrorProxy no se vuelve a envolver", () => {
  const original = new ErrorProxy(404, "drive-404");
  assert.equal(comoErrorProxy(original), original);
});

Deno.test("el detalle se recorta a 300 y sigue habiendo campo error para los clientes viejos", () => {
  const err = new ErrorProxy(502, "upstream", { detalle: "x".repeat(1000) });
  const cuerpo = cuerpoDeError(err, CTX);
  assert.equal(cuerpo.detalle.length, 300);
  assert.equal(cuerpo.error, cuerpo.detalle);
});

Deno.test("el rango enviado se informa solo cuando difiere del pedido", () => {
  const err = new ErrorProxy(416, "drive-sin-rangos");
  const igual = cuerpoDeError(err, { ...CTX, rangeEnviado: "bytes=-131072" });
  assert.equal(igual.rangeEnviado, undefined);
  const distinto = cuerpoDeError(err, { ...CTX, rangeEnviado: "bytes=16206979-16338050" });
  assert.equal(distinto.rangeEnviado, "bytes=16206979-16338050");
});

Deno.test("el id de fallo son 8 hex y no se repite", () => {
  const a = nuevoIdFallo();
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, nuevoIdFallo());
});
