// node --test src/lib/erroresDescarga.test.mjs
//
// Node 24 corre TypeScript con sintaxis erasable sin flags (probado: v24.15.0
// via `node archivo.ts`), asi que este test importa el modulo publicado tal
// cual, sin transpilar aparte.
import test from "node:test";
import assert from "node:assert/strict";
import { codigoDeErrorDescarga, detalleProxy, parseRangoFallido } from "./erroresDescarga.ts";

/** Copia mínima de lo que arma `VisorConcept/zip.ts`. No se importa el modulo
 * real a proposito: arrastra `device.ts`, que mira `navigator`, y este test
 * corre en Node. `detalleProxy` lee la forma, no la clase, justamente para
 * que esto sea posible. */
function errorProxy({ status, range = null, codigo = null, causa = null, idFallo = null }) {
  const err = new Error(`Rango ${range} fallo (${status})`);
  err.name = "ErrorProxyConcepts";
  return Object.assign(err, { status, range, codigo, causa, idFallo });
}

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

// --- Contrato de error de concepts-drive (R3-01) -------------------------

test("el codigo que manda la Edge Function manda sobre el deducido del mensaje", () => {
  // El caso real: el fileId quedo viejo en el cache de carpetas porque
  // Concepts re-subio el dibujo. El mensaje parece de rango, pero la funcion
  // ya dijo que fue SU fallo (UNX-F7001), no un rango que no se pudo servir.
  const err = errorProxy({ status: 404, range: "bytes=-131072", codigo: "UNX-F7001", causa: "drive-404", idFallo: "3f2a91cc" });
  assert.equal(codigoDeErrorDescarga(err), "UNX-F7001");
});

test("un rango que el servidor no puede servir sigue siendo F4005", () => {
  const err = errorProxy({ status: 416, range: "bytes=-131072", codigo: "UNX-F4005", causa: "drive-sin-rangos" });
  assert.equal(codigoDeErrorDescarga(err), "UNX-F4005");
});

test("detalleProxy devuelve los campos que van a la fila de unx_fallos", () => {
  const err = errorProxy({ status: 404, range: "bytes=-131072", codigo: "UNX-F7001", causa: "drive-404", idFallo: "3f2a91cc" });
  assert.deepEqual(detalleProxy(err), {
    status: 404,
    range: "bytes=-131072",
    codigo: "UNX-F7001",
    causa: "drive-404",
    idFallo: "3f2a91cc",
  });
});

test("un error que no viene del proxy no tiene detalle de proxy", () => {
  assert.equal(detalleProxy(new Error("Rango bytes=-131072 fallo (502)")), null);
  assert.equal(detalleProxy(null), null);
  assert.equal(detalleProxy("cancelado"), null);
  // Con el nombre pero sin status no alcanza: seria inventar campos.
  assert.equal(detalleProxy(Object.assign(new Error("x"), { name: "ErrorProxyConcepts" })), null);
});

test("sin codigo en el cuerpo se sigue deduciendo del mensaje (respuesta vieja)", () => {
  const err = errorProxy({ status: 502, range: "bytes=-131072" });
  assert.equal(codigoDeErrorDescarga(err), "UNX-F4005");
});
