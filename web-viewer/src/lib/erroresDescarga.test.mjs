// node --test src/lib/erroresDescarga.test.mjs
//
// Node 24 corre TypeScript con sintaxis erasable sin flags (probado: v24.15.0
// via `node archivo.ts`), asi que este test importa el modulo publicado tal
// cual, sin transpilar aparte.
import test from "node:test";
import assert from "node:assert/strict";
import { codigoDeErrorDescarga, parseRangoFallido } from "./erroresDescarga.ts";

test("un rango que fallo (502, sufijo) da F4005 y separa range/status", () => {
  const err = new Error("Rango bytes=-131072 fallo (502)");
  assert.equal(codigoDeErrorDescarga(err), "UNX-F4005");
  assert.deepEqual(parseRangoFallido(err.message), { range: "bytes=-131072", status: 502 });
});

test("un rango que fallo (503, con offsets) tambien da F4005", () => {
  const err = new Error("Rango bytes=1024-2047 fallo (503)");
  assert.equal(codigoDeErrorDescarga(err), "UNX-F4005");
  assert.deepEqual(parseRangoFallido(err.message), { range: "bytes=1024-2047", status: 503 });
});

test("un mensaje que no es de rango no matchea parseRangoFallido", () => {
  assert.equal(parseRangoFallido("cualquier otra cosa"), null);
});

test("ArchivoDemasiadoGrandeError da F4001", () => {
  const err = new Error(
    "Este archivo (300 MB) esta dañado, incompleto, o el servidor no soporta descarga parcial, y hace falta bajarlo entero para leerlo. En este dispositivo el limite es 96 MB."
  );
  assert.equal(codigoDeErrorDescarga(err), "UNX-F4001");
});

test("un encabezado local danado da F4002", () => {
  const err = new Error("Encabezado dañado para dibujo.dwg");
  assert.equal(codigoDeErrorDescarga(err), "UNX-F4002");
});

test("un zip sin ninguna entrada reconocible da F4002", () => {
  const err = new Error("No parece un archivo .concepts valido (no se encontro ninguna entrada)");
  assert.equal(codigoDeErrorDescarga(err), "UNX-F4002");
});

test("cualquier otro error (msgpack, parser) cae en F4003", () => {
  assert.equal(codigoDeErrorDescarga(new Error("Unexpected end of msgpack data")), "UNX-F4003");
});

test("un valor que no es Error tambien se mapea sin tirar", () => {
  assert.equal(codigoDeErrorDescarga("cancelado"), "UNX-F4003");
  assert.equal(codigoDeErrorDescarga(null), "UNX-F4003");
});
