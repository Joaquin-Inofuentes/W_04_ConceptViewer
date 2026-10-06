// node --test src/Gallery/transporteCore.test.mjs
//
// Cada test rompe UN eslabon de la cadena (funcion -> /salud del tunel ->
// firma -> frescura) y verifica que el resultado sea "Drive" sin que nada
// rechace, y que el modo global baje solo cuando corresponde.
import test from "node:test";
import assert from "node:assert/strict";
import { crearTransporte, copiaAlDia, rutaParaNodo, localizarEnArbol, REINTENTO_TRAS_CAIDA_MS, ESPERA_SONDA_MS } from "./transporteCore.ts";

const NODO = { id: "pc-x", tunelUrl: "https://t.example" };
const SANO = { ok: true, operativo: true, transporte: "conectado", interruptorActivo: false, carpetaCompartida: "C:\\ARQ" };
const PEDIDO = { fileId: "ID1", nombre: "Plano.concepts", ruta: ["Obra", "Concepts"], modifiedAt: "2026-10-01T12:00:00Z", hasTime: true };

function armar({ estado, salud, firmar, forzado = null, reloj = { t: 1_000_000 } } = {}) {
  const llamadas = [];
  const t = crearTransporte({
    async llamarFuncion(accion, params) {
      llamadas.push([accion, params]);
      const f = accion === "estado" ? estado : firmar;
      return typeof f === "function" ? f(params) : f;
    },
    async pedirSalud() {
      return typeof salud === "function" ? salud() : salud;
    },
    fuenteDrive: (id) => ({ url: `drive://${id}`, headers: { apikey: "k" } }),
    ahora: () => reloj.t,
    forzado: () => forzado,
  });
  return { t, llamadas, reloj };
}

const ESTADO_OK = { ok: true, firma: true, nodo: NODO };
const FIRMA_OK = { ok: true, url: "https://t.example/descargar?sig=A", size: 1000, mtimeMs: Date.parse("2026-10-02T00:00:00Z"), expiraEnMs: 1_000_000 + 600_000, nodoId: "pc-x" };

test("todo sano: sonda a tunel y la fuente sale del tunel con tamaño firmado", async () => {
  const { t } = armar({ estado: ESTADO_OK, salud: SANO, firmar: FIRMA_OK });
  const e = await t.iniciarSondeo();
  assert.equal(e.modo, "tunel");
  const f = await t.resolverFuente(PEDIDO);
  assert.equal(f.origen, "tunel");
  assert.equal(f.size, 1000);
  assert.equal(f.alternativa.url, "drive://ID1");
});

test("la ruta que se firma es carpetas + nombre con barras", async () => {
  const { t, llamadas } = armar({ estado: ESTADO_OK, salud: SANO, firmar: FIRMA_OK });
  await t.resolverFuente(PEDIDO);
  assert.deepEqual(llamadas.find((l) => l[0] === "firmar")[1], { ruta: "Obra/Concepts/Plano.concepts" });
  assert.equal(rutaParaNodo(["A"], "x.concepts"), "A/x.concepts");
});

for (const [nombre, cfg, motivo] of [
  ["no hay ningun nodo vivo", { estado: { ok: true, firma: true, nodo: null, motivo: "sin-nodos" }, salud: SANO }, "sin-nodos"],
  ["el secret de firma no esta cargado", { estado: { ok: true, firma: false, nodo: NODO }, salud: SANO }, "sin-firma"],
  ["la funcion de estado contesta ok:false", { estado: { ok: false }, salud: SANO }, "estado-fallo"],
  ["la funcion de estado se cae (red)", { estado: () => { throw new TypeError("fetch failed"); }, salud: SANO }, "sonda-fallo"],
  ["el /salud del tunel falla (CORS o tunel muerto)", { estado: ESTADO_OK, salud: () => { throw new TypeError("Failed to fetch"); } }, "sonda-fallo"],
  ["el /salud del tunel vence", { estado: ESTADO_OK, salud: () => { throw new DOMException("t", "TimeoutError"); } }, "sonda-timeout"],
  ["el nodo dice operativo:false", { estado: ESTADO_OK, salud: { ...SANO, operativo: false } }, "tunel-no-sirve"],
  ["el interruptor del nodo esta cortado", { estado: ESTADO_OK, salud: { ...SANO, interruptorActivo: true } }, "tunel-no-sirve"],
  ["el tunel no esta conectado", { estado: ESTADO_OK, salud: { ...SANO, transporte: "caido" } }, "tunel-no-sirve"],
]) {
  test(`cae a Drive cuando ${nombre}`, async () => {
    const { t, llamadas } = armar({ ...cfg, firmar: FIRMA_OK });
    const e = await t.iniciarSondeo();
    assert.equal(e.modo, "drive");
    assert.equal(e.motivo, motivo);
    const f = await t.resolverFuente(PEDIDO);
    assert.equal(f.origen, "drive");
    assert.equal(f.url, "drive://ID1");
    assert.equal(llamadas.filter((l) => l[0] === "firmar").length, 0, "no debe ni intentar firmar");
  });
}

test("forzado=drive: no consulta nada", async () => {
  const { t, llamadas } = armar({ estado: ESTADO_OK, salud: SANO, firmar: FIRMA_OK, forzado: "drive" });
  const f = await t.resolverFuente(PEDIDO);
  assert.equal(f.origen, "drive");
  assert.equal(f.motivo, "forzado");
  assert.equal(llamadas.length, 0);
});

test("un archivo que el nodo no tiene va a Drive pero el tunel sigue vivo para los demas", async () => {
  let n = 0;
  const { t } = armar({ estado: ESTADO_OK, salud: SANO, firmar: () => (n++ === 0 ? { ok: false, motivo: "no-esta-en-nodo" } : FIRMA_OK) });
  assert.equal((await t.resolverFuente(PEDIDO)).origen, "drive");
  assert.equal((await t.resolverFuente({ ...PEDIDO, nombre: "Otro.concepts" })).origen, "tunel");
});

test("si el nodo dice que el tunel no responde, TODOS los pedidos siguientes van a Drive", async () => {
  let n = 0;
  const { t, llamadas } = armar({ estado: ESTADO_OK, salud: SANO, firmar: () => (n++ === 0 ? { ok: false, motivo: "tunel-no-responde" } : FIRMA_OK) });
  assert.equal((await t.resolverFuente(PEDIDO)).origen, "drive");
  const f2 = await t.resolverFuente({ ...PEDIDO, nombre: "Otro.concepts" });
  assert.equal(f2.origen, "drive");
  assert.match(f2.motivo, /^caido:tunel-no-responde/);
  assert.equal(llamadas.filter((l) => l[0] === "firmar").length, 1, "no insiste con un tunel caido");
});

test("si pedir la firma falla por red, cae a Drive y baja el modo", async () => {
  const { t } = armar({ estado: ESTADO_OK, salud: SANO, firmar: () => { throw new TypeError("fetch failed"); } });
  const f = await t.resolverFuente(PEDIDO);
  assert.equal(f.origen, "drive");
  assert.equal(f.motivo, "firmar-fallo");
  assert.equal((await t.estadoActual()).modo, "drive");
});

test("copia del nodo mas vieja que la de Drive: Drive, sin bajar el modo", async () => {
  const vieja = { ...FIRMA_OK, mtimeMs: Date.parse("2026-09-01T00:00:00Z") };
  const { t } = armar({ estado: ESTADO_OK, salud: SANO, firmar: vieja });
  const f = await t.resolverFuente(PEDIDO);
  assert.equal(f.origen, "drive");
  assert.equal(f.motivo, "nodo-desactualizado");
  assert.equal((await t.estadoActual()).modo, "tunel");
});

test("respuesta de firma incompleta (sin tamaño) no se usa", async () => {
  const { t } = armar({ estado: ESTADO_OK, salud: SANO, firmar: { ok: true, url: "https://t/x" } });
  assert.equal((await t.resolverFuente(PEDIDO)).origen, "drive");
});

test("una sonda lenta no hace esperar al pedido: usa Drive ese pedido y el tunel el siguiente", async () => {
  let soltar;
  const lenta = new Promise((r) => (soltar = r));
  const { t } = armar({ estado: () => lenta, salud: SANO, firmar: FIRMA_OK });
  const t0 = Date.now();
  const f = await t.resolverFuente(PEDIDO);
  assert.equal(f.origen, "drive");
  assert.equal(f.motivo, "sonda-pendiente");
  assert.ok(Date.now() - t0 < ESPERA_SONDA_MS + 700, "no espera mas que el tope");
  soltar(ESTADO_OK);
  await t.iniciarSondeo();
  assert.equal((await t.resolverFuente(PEDIDO)).origen, "tunel");
});

test("tras una caida vuelve a probar el tunel pasados 2 minutos", async () => {
  const { t, reloj } = armar({ estado: ESTADO_OK, salud: SANO, firmar: FIRMA_OK });
  await t.iniciarSondeo();
  t.marcarCaido("prueba");
  assert.equal((await t.estadoActual()).modo, "drive");
  reloj.t += REINTENTO_TRAS_CAIDA_MS + 1;
  await t.estadoActual(); // dispara la re-sonda en segundo plano
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await t.estadoActual()).modo, "tunel");
});

test("antes de los 2 minutos de caida NO vuelve a probar", async () => {
  const { t, reloj, llamadas } = armar({ estado: ESTADO_OK, salud: SANO, firmar: FIRMA_OK });
  await t.iniciarSondeo();
  t.marcarCaido("prueba");
  reloj.t += REINTENTO_TRAS_CAIDA_MS - 5_000;
  await t.estadoActual();
  assert.equal(llamadas.filter((l) => l[0] === "estado").length, 1);
});

test("dos pedidos simultaneos del mismo dibujo comparten UNA firma", async () => {
  const { t, llamadas } = armar({ estado: ESTADO_OK, salud: SANO, firmar: FIRMA_OK });
  await t.iniciarSondeo();
  await Promise.all([t.resolverFuente(PEDIDO), t.resolverFuente(PEDIDO), t.resolverFuente(PEDIDO)]);
  assert.equal(llamadas.filter((l) => l[0] === "firmar").length, 1);
});

test("renovar: con permiso vigente reutiliza; por vencer pide otro; si cambio el tamaño devuelve null", async () => {
  const { t, llamadas, reloj } = armar({ estado: ESTADO_OK, salud: SANO, firmar: FIRMA_OK });
  const f = await t.resolverFuente(PEDIDO);
  assert.equal((await f.renovar()).url, FIRMA_OK.url);
  assert.equal(llamadas.filter((l) => l[0] === "firmar").length, 1, "vigente: no pide otro");

  let k = 0;
  const { t: t2, llamadas: ll2, reloj: r2 } = armar({
    estado: ESTADO_OK,
    salud: SANO,
    firmar: () => (k++ === 0 ? FIRMA_OK : { ...FIRMA_OK, url: "https://t/nuevo", expiraEnMs: 9e12 }),
  });
  const f2 = await t2.resolverFuente(PEDIDO);
  r2.t = FIRMA_OK.expiraEnMs - 1_000;
  assert.equal((await f2.renovar()).url, "https://t/nuevo");
  assert.equal(ll2.filter((l) => l[0] === "firmar").length, 2);

  let n = 0;
  const { t: t3, reloj: r3 } = armar({ estado: ESTADO_OK, salud: SANO, firmar: () => (n++ === 0 ? FIRMA_OK : { ...FIRMA_OK, size: 2000 }) });
  const f3 = await t3.resolverFuente(PEDIDO);
  r3.t = FIRMA_OK.expiraEnMs - 1_000;
  assert.equal(await f3.renovar(), null, "archivo cambio: los offsets leidos ya no valen");
});

test("copiaAlDia", () => {
  const drive = "2026-10-01T12:00:00Z";
  const ms = (s) => Date.parse(s);
  assert.equal(copiaAlDia(ms("2026-10-01T12:00:00Z"), drive, true), true, "igual");
  assert.equal(copiaAlDia(ms("2026-10-02T00:00:00Z"), drive, true), true, "mas nueva");
  assert.equal(copiaAlDia(ms("2026-10-01T11:55:00Z"), drive, true), true, "dentro de la tolerancia");
  assert.equal(copiaAlDia(ms("2026-10-01T11:00:00Z"), drive, true), false, "una hora mas vieja");
  assert.equal(copiaAlDia(ms("2026-09-30T00:00:00Z"), drive, true), false, "de ayer");
  assert.equal(copiaAlDia(NaN, drive, true), false, "sin mtime del nodo");
  assert.equal(copiaAlDia(ms("2026-10-01T00:00:00Z"), null, true), true, "Drive sin fecha: se confia");
  assert.equal(copiaAlDia(ms("2026-10-01T00:00:00Z"), "basura", true), true, "fecha ilegible: se confia");
});

test("localizarEnArbol: id -> nombre real, carpetas desde la raiz y fecha", () => {
  const f = (id, name, modifiedAt = "2026-10-01T10:00:00Z", hasTime = true) => ({ id, name, modifiedAt, hasTime });
  const arbol = new Map(
    [
      { folder_id: "R", name: "Inicio", subfolders: [{ id: "G", name: "Guada y Flor Re" }], files: [] },
      { folder_id: "G", name: "Guada y Flor Re", subfolders: [{ id: "C", name: "Concepts" }], files: [] },
      { folder_id: "C", name: "Concepts", subfolders: [{ id: "O", name: "ROOSEVELT 4464" }], files: [] },
      { folder_id: "O", name: "ROOSEVELT 4464", subfolders: [], files: [f("A1", "RO 3er y 4to..concepts"), f("A2", "Otro.concepts", null, false)] },
      // Otra carpeta "Concepts" mas arriba, con otro archivo: no debe mezclar rutas.
      { folder_id: "C2", name: "Concepts", subfolders: [], files: [f("B1", "Suelto.concepts")] },
    ].map((x) => [x.folder_id, x]),
  );
  assert.deepEqual(localizarEnArbol(arbol, "A1"), {
    nombre: "RO 3er y 4to..concepts",
    ruta: ["Guada y Flor Re", "Concepts", "ROOSEVELT 4464"],
    modifiedAt: "2026-10-01T10:00:00Z",
    hasTime: true,
  });
  assert.equal(localizarEnArbol(arbol, "A2").modifiedAt, null);
  assert.equal(localizarEnArbol(arbol, "NO-EXISTE"), null);
  // Una carpeta huerfana (sin camino a la raiz) no da una ruta inventada: ruta [] = archivo en la raiz.
  assert.deepEqual(localizarEnArbol(arbol, "B1").ruta, []);
});
