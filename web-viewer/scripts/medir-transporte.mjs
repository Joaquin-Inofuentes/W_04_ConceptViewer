// Mide, contra PRODUCCION, cuanto tarda leer el dibujo mas pesado por el tunel
// al nodo vs por el proxy de Drive. Los rangos son los que el visor pide de
// verdad al abrir: la cola del zip (indice), el principio (tree.pack/thumb) y
// un bloque de recurso, mas un tramo secuencial para ver el ancho de banda.
//
//   node scripts/medir-transporte.mjs [veces=3] [ruta/del/dibujo.concepts]
//
// El tunel necesita que la funcion `concepts-nodo` tenga el secret
// UNX_NODO_TOKEN; sin el, esa mitad sale "no disponible" y se mide solo Drive.

import { readFileSync } from "node:fs";

const cfg = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const ANON = /SUPABASE_ANON_KEY =\s*"([^"]+)"/.exec(cfg)[1];
const SB = /SUPABASE_URL = "([^"]+)"/.exec(cfg)[1];
const DEMO_ID = /DEMO_FILE_ID = "([^"]+)"/.exec(cfg)[1];
const VECES = Number(process.argv[2] ?? 3);
const RUTA = process.argv[3] ?? "Guada y Flor Re/Concepts/ROOSEVELT 4464/3er piso/RO 3er y 4to..concepts";
const H = { apikey: ANON, Authorization: `Bearer ${ANON}` };
const MB = 1048576;

const ms = () => performance.now();
const mediana = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function leer(url, headers, rango) {
  const t0 = ms();
  const r = await fetch(url, { headers: { ...headers, Range: rango }, signal: AbortSignal.timeout(180_000) });
  const buf = new Uint8Array(await r.arrayBuffer());
  return { ms: ms() - t0, status: r.status, bytes: buf.length };
}

// --- fuente Drive ---
const driveUrl = `${SB}/functions/v1/concepts-drive?action=download&fileId=${DEMO_ID}`;
const drive = {
  nombre: "Drive (proxy concepts-drive)",
  async total() {
    const r = await fetch(`${driveUrl}&range=-1`, { headers: { ...H, Range: "bytes=-1" } });
    const t = Number(r.headers.get("x-drive-total") ?? 0);
    await r.arrayBuffer();
    return t;
  },
  leer: (a, b) => leer(`${driveUrl}&range=${a}-${b}`, H, `bytes=${a}-${b}`),
};

// --- fuente tunel ---
async function fuenteTunel() {
  const q = new URLSearchParams({ action: "firmar", ruta: RUTA });
  const t0 = ms();
  const f = await (await fetch(`${SB}/functions/v1/concepts-nodo?${q}`, { headers: H })).json();
  const msFirma = ms() - t0;
  if (!f.ok) return { nombre: "Tunel (nodo)", noDisponible: f.motivo };
  const ts = ms();
  const salud = await fetch(new URL("/salud", f.url)).then((r) => r.json()).catch(() => null);
  return {
    nombre: "Tunel (nodo)",
    msFirma,
    rttSalud: ms() - ts,
    saludOk: salud?.ok,
    total: f.size,
    leer: (a, b) => leer(f.url, {}, `bytes=${a}-${b}`),
  };
}

const tunel = await fuenteTunel();
const total = (tunel.total ?? (await drive.total())) || 275656257;
console.log(`Dibujo: ${RUTA}\nTamaño: ${(total / MB).toFixed(1)} MB   veces: ${VECES}\n`);

const PASOS = [
  ["1 byte (latencia pura)", 0, 0],
  ["cola 128 KB (indice del zip)", total - 128 * 1024, total - 1],
  ["inicio 1 MB (tree.pack)", 0, 1 * MB - 1],
  ["bloque 3 MB (recurso)", 40 * MB, 43 * MB - 1],
  ["tramo 16 MB (ancho de banda)", 80 * MB, 96 * MB - 1],
];

const filas = [];
for (const fuente of [tunel, drive]) {
  if (fuente.noDisponible) {
    console.log(`${fuente.nombre}: NO DISPONIBLE (${fuente.noDisponible})`);
    continue;
  }
  if (fuente.msFirma) console.log(`${fuente.nombre}: pedir permiso ${fuente.msFirma.toFixed(0)} ms, /salud directo ${fuente.rttSalud.toFixed(0)} ms`);
  for (const [nombre, a, b] of PASOS) {
    const tiempos = [];
    let ultimo;
    for (let i = 0; i < VECES; i++) {
      try {
        ultimo = await fuente.leer(a, b);
        if (ultimo.status !== 206) throw new Error(`status ${ultimo.status}`);
        tiempos.push(ultimo.ms);
      } catch (e) {
        tiempos.push(NaN);
        ultimo = { error: String(e) };
      }
    }
    const ok = tiempos.filter(Number.isFinite);
    filas.push({
      fuente: fuente.nombre,
      paso: nombre,
      medianaMs: ok.length ? Math.round(mediana(ok)) : null,
      minMs: ok.length ? Math.round(Math.min(...ok)) : null,
      maxMs: ok.length ? Math.round(Math.max(...ok)) : null,
      MBps: ok.length && ultimo.bytes ? +(ultimo.bytes / MB / (mediana(ok) / 1000)).toFixed(2) : null,
      fallos: tiempos.length - ok.length,
    });
  }
}
console.table(filas);
// Apertura tipica de un dibujo: cola + inicio + 1 bloque de recurso (lo que lee el visor para dibujar).
for (const fuente of [tunel, drive]) {
  if (fuente.noDisponible) continue;
  const f = filas.filter((x) => x.fuente === fuente.nombre);
  const suma = ["cola", "inicio", "bloque"].reduce((s, k) => s + (f.find((x) => x.paso.startsWith(k))?.medianaMs ?? NaN), 0);
  console.log(`${fuente.nombre}: apertura tipica en serie (cola + inicio + bloque) ≈ ${suma} ms`);
}
