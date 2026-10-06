// Nodo falso para probar el "sistema de llamados" (Gallery/transporte.ts) sin
// tocar la PC real ni su tunel. Imita al `_FilesSync` en lo que importa y lo
// que el navegador puede notar:
//
//  - Las firmas se verifican con las MISMAS funciones que el nodo real
//    (`verificarFirmaPedido` / `verificarFirmaDescarga` de @unx/contratos),
//    no con una copia: si la funcion `concepts-nodo` firma mal, aca da 401.
//  - CORS identico al medido contra el nodo real: solo los origenes
//    permitidos, `Allow-Headers` SIN `Range`, y `Expose-Headers` SIN
//    `Content-Range`. Un cliente que dependa de eso falla aca igual que en
//    produccion.
//  - Sirve archivos REALES de una carpeta (`--raiz`), con Range 206.
//  - Falla a pedido (`/__ctl?modo=...`) para probar el respaldo a Drive.
//
// Tambien levanta una "flota" falsa en otro puerto que contesta la RPC
// `unx_estado_flota` de Supabase apuntando a este nodo, asi la Edge Function
// corre local sin Supabase.
//
//   node scripts/nodo-falso.mjs [--puerto 4180] [--flota 4181] [--raiz C:\ARQ]
//        [--secreto secreto-de-prueba] [--origenes http://localhost:5173,...]
//
// Control (GET, sin CORS, para el arnes):
//   /__ctl?modo=normal|caido|sinrangos|corta|lento|expirar|saludmala|sinnodos|cambiatamano
//   /__ctl?ms=1500                (con modo=lento: demora por rango)
//   /__ctl?origenes=a,b           origenes con CORS (por defecto los de localhost:5173)
//   /__stats                      contadores; /__stats?reset=1 los pone en cero

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { verificarFirmaDescarga, verificarFirmaPedido } from "../../../W_07_Files/packages/contratos/src/firma-descarga.ts";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PUERTO = Number(arg("puerto", 4180));
const PUERTO_FLOTA = Number(arg("flota", 4181));
const RAIZ = arg("raiz", "C:\\ARQ").replace(/[\\/]+$/, "");
const SECRETO = arg("secreto", "secreto-de-prueba");
let ORIGENES = arg("origenes", "http://localhost:5173,http://127.0.0.1:5173").split(",");

const estado = { modo: "normal", ms: 1500 };
const stats = { salud: 0, listar: 0, descargas: 0, bytes: 0, rangos: [], rechazos: 0, preflights: 0, preflightsConRange: 0 };

function aplicarCors(req, res) {
  const origen = req.headers.origin;
  if (typeof origen === "string" && ORIGENES.includes(origen)) {
    res.setHeader("Access-Control-Allow-Origin", origen);
    res.setHeader("Vary", "Origin");
    // Identico al nodo real: NO incluye Range, NO expone Content-Range.
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Unx-Usuario, X-Unx-Ip");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Disposition, X-Sha256, X-Unx-Tamano-Real");
  }
}

function json(res, status, cuerpo) {
  const b = Buffer.from(JSON.stringify(cuerpo));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": b.length, "Cache-Control": "no-store" });
  res.end(b);
}

/** Ruta del nodo (`C:\ARQ\...`) -> disco real, sin salir de la raiz. */
function aDisco(rutaNodo) {
  const rel = rutaNodo.slice(RAIZ.length).replace(/^[\\/]+/, "");
  if (!rutaNodo.toLowerCase().startsWith(RAIZ.toLowerCase())) return null;
  const real = path.resolve(RAIZ, rel);
  return real.toLowerCase().startsWith(path.resolve(RAIZ).toLowerCase()) ? real : null;
}

function parsearRango(h, total) {
  if (!h) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let ini;
  let fin;
  if (m[1] === "") {
    ini = Math.max(0, total - Number(m[2]));
    fin = total - 1;
  } else {
    ini = Number(m[1]);
    fin = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  return ini > fin || ini >= total ? null : { ini, fin };
}

const nodo = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/__ctl") {
    if (url.searchParams.get("modo")) estado.modo = url.searchParams.get("modo");
    if (url.searchParams.get("ms")) estado.ms = Number(url.searchParams.get("ms"));
    // Cambia los origenes que reciben CORS (para simular "el servidor llega al tunel pero este navegador no").
    if (url.searchParams.get("origenes")) ORIGENES = url.searchParams.get("origenes").split(",");
    return json(res, 200, estado);
  }
  if (url.pathname === "/__stats") {
    const copia = JSON.parse(JSON.stringify(stats));
    if (url.searchParams.get("reset")) {
      Object.assign(stats, { salud: 0, listar: 0, descargas: 0, bytes: 0, rangos: [], rechazos: 0, preflights: 0, preflightsConRange: 0 });
    }
    return json(res, 200, copia);
  }

  if (estado.modo === "caido") return req.socket.destroy(); // el tunel muerto: ni respuesta
  aplicarCors(req, res);

  if (req.method === "OPTIONS") {
    stats.preflights++;
    if ((req.headers["access-control-request-headers"] ?? "").toLowerCase().includes("range")) stats.preflightsConRange++;
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === "/salud") {
    stats.salud++;
    return json(res, 200, {
      ok: true,
      modo: "normal",
      operativo: estado.modo !== "saludmala",
      nodoId: "pc-falsa",
      transporte: "conectado",
      interruptorActivo: false,
      carpetaCompartida: RAIZ,
    });
  }

  if (url.pathname === "/listar" && req.method === "POST") {
    stats.listar++;
    const exp = Number(req.headers["x-unx-exp"]);
    const sig = String(req.headers["x-unx-sig"] ?? "");
    const ok = await verificarFirmaPedido(SECRETO, { metodo: "POST", ruta: "/listar", expiraEnMs: exp, nombreUsuario: null }, sig);
    if (!ok) {
      stats.rechazos++;
      return json(res, 401, { error: "no autorizado" });
    }
    const cuerpo = await new Promise((r) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => r(JSON.parse(b || "{}")));
    });
    const carpetaDisco = aDisco(String(cuerpo.carpeta ?? ""));
    if (!carpetaDisco || !fs.existsSync(carpetaDisco) || !fs.statSync(carpetaDisco).isDirectory()) {
      return json(res, 404, { error: "carpeta no encontrada", codigo: "UNX-1004" });
    }
    const filas = fs
      .readdirSync(carpetaDisco, { withFileTypes: true })
      .map((d) => {
        const st = fs.statSync(path.join(carpetaDisco, d.name));
        return {
          ruta_absoluta: `${cuerpo.carpeta}\\${d.name}`,
          nombre: d.name,
          extension: path.extname(d.name),
          tamano_bytes: d.isDirectory() ? 0 : st.size + (estado.modo === "cambiatamano" ? 1 : 0),
          fecha_modificacion: st.mtime.toISOString(),
          es_carpeta: d.isDirectory(),
          root_id: "principal",
          puede_descargar: true,
        };
      })
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
    const porPagina = cuerpo.porPagina ?? 30;
    const pagina = cuerpo.pagina ?? 0;
    return json(res, 200, {
      resultados: filas.slice(pagina * porPagina, (pagina + 1) * porPagina),
      motorUsado: "indice-local",
      degradado: false,
      truncado: false,
      total: filas.length,
      pagina,
      porPagina,
      desdeCache: false,
    });
  }

  if (url.pathname === "/descargar" && req.method === "GET") {
    const ruta = url.searchParams.get("ruta") ?? "";
    const firmado = await verificarFirmaDescarga(
      SECRETO,
      {
        rutaAbsoluta: ruta,
        expiraEnMs: Number(url.searchParams.get("exp")),
        nombreUsuario: url.searchParams.get("usr"),
        ip: url.searchParams.get("ip"),
        inline: url.searchParams.get("disp") === "inline",
      },
      url.searchParams.get("sig") ?? "",
    );
    if (!firmado || estado.modo === "expirar") {
      stats.rechazos++;
      return json(res, 401, { error: "no autorizado" });
    }
    const disco = aDisco(ruta);
    if (!disco || !fs.existsSync(disco)) return json(res, 404, { error: "no encontrado", codigo: "UNX-1004" });
    const total = fs.statSync(disco).size;
    const pedido = req.headers.range;
    let rango = estado.modo === "sinrangos" ? undefined : parsearRango(pedido, total);
    if (rango === null) {
      res.writeHead(416, { "Content-Range": `bytes */${total}`, "Content-Length": "0" });
      return res.end();
    }
    stats.descargas++;
    stats.rangos.push(pedido ?? "(entero)");
    if (estado.modo === "lento") await new Promise((r) => setTimeout(r, estado.ms));
    const ini = rango?.ini ?? 0;
    const fin = rango?.fin ?? total - 1;
    const largo = fin - ini + 1;
    res.writeHead(rango ? 206 : 200, {
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Length": String(largo),
      ...(rango ? { "Content-Range": `bytes ${ini}-${fin}/${total}` } : {}),
      "Cache-Control": "no-store",
    });
    const enviar = estado.modo === "corta" ? Math.floor(largo / 2) : largo;
    let mandados = 0;
    const flujo = fs.createReadStream(disco, { start: ini, end: ini + Math.max(0, enviar - 1) });
    flujo.on("data", (c) => {
      mandados += c.length;
      stats.bytes += c.length;
    });
    flujo.on("end", () => {
      // "corta": promete `largo` y cierra el socket a la mitad (tunel cortado).
      if (enviar < largo) req.socket.destroy();
      else res.end();
    });
    if (enviar === 0) return res.end();
    flujo.pipe(res, { end: false });
    return;
  }

  res.writeHead(404);
  res.end();
});

const flota = http.createServer(async (req, res) => {
  if (req.url?.includes("/rest/v1/rpc/unx_estado_flota")) {
    const nodos =
      estado.modo === "sinnodos"
        ? []
        : [
            {
              id: "pc-falsa",
              nombre: "pc-falsa",
              activo: true,
              modo: "normal",
              tunel_url: `http://127.0.0.1:${PUERTO}`,
              ultimo_heartbeat: new Date().toISOString(),
            },
          ];
    return json(res, 200, nodos);
  }
  res.writeHead(404);
  res.end();
});

nodo.listen(PUERTO, "127.0.0.1", () => console.log(`nodo falso   http://127.0.0.1:${PUERTO}  raiz=${RAIZ}`));
flota.listen(PUERTO_FLOTA, "127.0.0.1", () => console.log(`flota falsa  http://127.0.0.1:${PUERTO_FLOTA}`));
