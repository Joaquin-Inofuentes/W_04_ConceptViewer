// Proxy publico (sin API key) para leer una carpeta publica de Google Drive
// (con subcarpetas anidadas) y descargar archivos .concepts desde ella.
// Usado por ConceptSerializer web-viewer para listar y abrir dibujos sin
// pasar por Drive API/OAuth.
//
// Solo la carpeta RAIZ se hardcodea del lado del cliente (ver src/config.ts);
// tanto el listado de archivos como el de subcarpetas se resuelven en vivo
// aca para cualquier folderId (raiz o subcarpeta), asi que altas/bajas de
// archivos O carpetas se reflejan solas en el proximo listado.
//
// GET ?action=list&folderId=...     -> { ok, folders: [{id,name}], files: [{id,name,modifiedAt,hasTime}] }
//   files viene ordenado del mas reciente al mas viejo (por modifiedAt).
// GET ?action=download&fileId=...   -> bytes crudos del archivo (application/octet-stream)
//   Acepta Range (header o ?range=a-b) y devuelve 206 + Content-Range.
//   Devuelve X-Drive-Url con la URL ya resuelta; el cliente la reenvia en ?u=
//   para que los rangos siguientes no re-resuelvan el interstitial de virus.
//
// TODO fallo sale con el contrato de `errores.ts`: status que dice de quien
// fue la culpa, `codigo` del catalogo del parque, `causa` corta, `detalle` y
// un `id` que tambien se escribe con console.error. Ver ese archivo.
//
// Desplegado en Supabase (proyecto kuhcxzusnrttkywgalgk) via el MCP de
// Supabase; este archivo es la copia versionada en git, no se autodespliega
// desde aca — si se edita hay que redesplegar manualmente con
// deploy_edge_function o el Supabase CLI. Se redespliega junto con
// `errores.ts` y `rangos.ts`, que son parte de la misma funcion.

import {
  CODIGO_RANGO,
  ErrorProxy,
  comoErrorProxy,
  cuerpoDeError,
  nuevoIdFallo,
} from "./errores.ts";
import {
  RangoInvalido,
  aAbsoluto,
  formatearRango,
  parsearRango,
  totalDeContentRange,
  type RangoPedido,
} from "./rangos.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, range",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  // Sin esto el navegador no deja leer Content-Range/Content-Length desde JS
  // (son headers no-simples en una respuesta cross-origin), y el lector de
  // zip por rangos no puede saber el tamaño real del archivo.
  "Access-Control-Expose-Headers": "content-range, content-length, accept-ranges, x-drive-total, x-drive-url",
};

const JSON_CORS = { ...CORS, "Content-Type": "application/json" };

// Hosts a los que este proxy acepta reenviar una URL ya resuelta (parametro
// `u`). Sin esta lista blanca seria un proxy abierto: cualquiera podria pedir
// que descargue una URL arbitraria usando nuestro edge function.
const HOSTS_DRIVE = new Set(["drive.google.com", "drive.usercontent.google.com"]);

// Los ids de Drive son alfanumericos + "-"/"_", tipicamente 28-44
// caracteres (algunos legados son mas cortos). `folderId`/`fileId` NO
// tenian ninguna validacion mas alla de "no vacio": cualquiera podia
// pedirle a este proxy que listara o descargara CUALQUIER archivo publico
// de Drive del planeta, consumiendo el egress y la cuota de invocaciones de
// este proyecto (la SUPABASE_ANON_KEY que habilita esto vive en el bundle
// JS publico, sin expiracion util). Esta validacion no reemplaza una lista
// blanca real (verificar que el id pertenece al arbol de DRIVE_FOLDER_ID
// exigiria consultar la tabla drive_folder_cache desde aca), pero cierra el
// caso mas barato: un id que ni siquiera tiene la forma de un id de Drive
// se rechaza antes de gastar una sola request contra Drive. Tambien cierra
// la inyeccion de query string: folderId/fileId se interpolan crudos en la
// URL a Drive (`listarCarpetaPublica`, `resolverUrlDescarga`, etc.), y un
// valor con "&" adicionales podia agregar parametros no previstos.
const ID_DRIVE_VALIDO = /^[A-Za-z0-9_-]{10,80}$/;

function validarIdDrive(id: string, etiqueta: string): void {
  if (!ID_DRIVE_VALIDO.test(id)) {
    throw new ErrorProxy(400, "pedido-invalido", { detalle: `${etiqueta} invalido` });
  }
}

function urlResueltaValida(u: string | null): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return null;
    return HOSTS_DRIVE.has(parsed.hostname) ? u : null;
  } catch {
    return null;
  }
}

type EntradaDrive = {
  id: string;
  nombre: string;
  esCarpeta: boolean;
  modificadoTexto: string | null;
};

// Mismo parseo por bloques que usa recuperar-plano-drive: mas robusto que
// un regex monolitico contra el HTML minificado que devuelve Drive.
function parsearCarpeta(html: string): EntradaDrive[] {
  const salida: EntradaDrive[] = [];
  const bloques = html.split('<div class="flip-entry" id="entry-').slice(1);
  for (const bloque of bloques) {
    const idm = /^([^"]+)"/.exec(bloque);
    const hrefm = /href="([^"]+)"/.exec(bloque);
    const titm = /<div class="flip-entry-title">([^<]*)<\/div>/.exec(bloque);
    if (!idm || !hrefm || !titm) continue;
    const modm = /<div class="flip-entry-last-modified"><div>([^<]*)<\/div>/.exec(bloque);
    salida.push({
      id: idm[1],
      nombre: titm[1],
      esCarpeta: hrefm[1].includes("/drive/folders/"),
      modificadoTexto: modm ? modm[1].trim() : null,
    });
  }
  return salida;
}

async function listarCarpetaPublica(folderId: string): Promise<EntradaDrive[]> {
  // hl=en fuerza nombres de mes en ingles para poder parsearlos de forma
  // deterministica (sin esto Drive devuelve el idioma segun geo/headers).
  const r = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}&hl=en#list`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new ErrorProxy(r.status === 404 ? 404 : 502, r.status === 404 ? "drive-404" : "upstream", {
      upstreamStatus: r.status,
      detalle: `Drive folder ${r.status}`,
    });
  }
  return parsearCarpeta(await r.text());
}

// --- Hora real de modificacion (no solo fecha) ---------------------------
// La vista publica "embeddedfolderview" usada arriba solo expone hora real
// ("HH:MM AM/PM") para archivos modificados HOY; para el resto solo da el
// dia. La pagina PUBLICA (sin login) de la carpeta completa en cambio trae
// embebido un blob JS interno (window['_DRIVE_ivd']) con metadata cruda por
// archivo, incluyendo un timestamp real en milisegundos — sin API key ni
// OAuth, es la misma carpeta publica, solo que la pagina completa en vez
// de la vista embebida. Es un formato interno no documentado (puede romper
// si Google cambia el frontend), asi que esto es una mejora "best effort":
// si falla o no matchea, se sigue con el fallback de solo-fecha de arriba.
//
// Verificado empiricamente: cada fila trae dos timestamps consecutivos
// (viewedByMeTime, modifiedTime); el segundo es el que coincide con la
// fecha que ya de por si informa la vista embebida, asi que es el que se usa.
function decodeHexEscapes(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

async function fetchIvdModifiedTimes(folderId: string): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  try {
    const r = await fetch(`https://drive.google.com/drive/folders/${folderId}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return map;
    const html = await r.text();
    const blobMatch = /_DRIVE_ivd'\]\s*=\s*'((?:\\.|[^'\\])*)'/.exec(html);
    if (!blobMatch) return map;
    const decoded = decodeHexEscapes(blobMatch[1]);
    // Cada fila: ["id",["parentFolderId"],"nombre","mimeType",N,(null|N),N,N,N,VIEWED_MS,MODIFIED_MS,...
    const rowRe = /\["([\w-]{15,})",\[[^\]]*\],"((?:\\.|[^"\\])*)","([^"]*)",\d+,(?:null|\d+),\d+,\d+,\d+,(\d+),(\d+),/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(decoded)) !== null) {
      const id = m[1];
      const modifiedMs = parseInt(m[5], 10);
      if (Number.isFinite(modifiedMs) && modifiedMs > 0) {
        map[id] = modifiedMs;
      }
    }
  } catch (_e) {
    // Best-effort: si falla (timeout, formato cambiado, etc.) seguimos con
    // el fallback de solo-fecha, no rompe el listado.
  }
  return map;
}

const MESES: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Fallback cuando no se pudo resolver la hora real via _DRIVE_ivd: Drive
// (vista publica, sin login) solo expone "HH:MM AM/PM" para archivos
// modificados hoy, "Mon D" para el resto del año en curso, o "Mon D, YYYY"
// para años anteriores.
function parsearFechaModificado(texto: string | null, ahora: Date): { iso: string | null; hasTime: boolean } {
  if (!texto) return { iso: null, hasTime: false };
  const t = texto.trim();

  const horaMatch = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t);
  if (horaMatch) {
    let h = parseInt(horaMatch[1], 10) % 12;
    if (horaMatch[3].toUpperCase() === "PM") h += 12;
    const min = parseInt(horaMatch[2], 10);
    const d = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate(), h, min));
    return { iso: d.toISOString(), hasTime: true };
  }

  let m = /^([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{4})$/.exec(t);
  if (m) {
    const mes = MESES[m[1].toLowerCase()];
    if (mes) return { iso: `${m[3]}-${mes}-${m[2].padStart(2, "0")}T00:00:00.000Z`, hasTime: false };
  }

  m = /^([A-Za-z]{3})\w*\s+(\d{1,2})$/.exec(t);
  if (m) {
    const mes = MESES[m[1].toLowerCase()];
    if (mes) return { iso: `${ahora.getUTCFullYear()}-${mes}-${m[2].padStart(2, "0")}T00:00:00.000Z`, hasTime: false };
  }

  return { iso: null, hasTime: false };
}

// --- Descarga con interstitial ------------------------------------------
// Drive no escanea por virus los archivos grandes (>~25 MB) y en vez del
// archivo devuelve una pagina "Google Drive can't scan this file for
// viruses" con un formulario de confirmacion. Antes esto se trataba como
// error, asi que ~30% de los .concepts (los mas pesados, hasta 87 MB) eran
// imposibles de abrir desde la app. El form trae la URL real de descarga
// (drive.usercontent.google.com) mas los parametros id/export/confirm/uuid:
// alcanza con reenviarlo tal cual.
function urlDesdeInterstitial(html: string): string | null {
  const form = /<form[^>]+id="download-form"[^>]+action="([^"]+)"/.exec(html);
  if (!form) return null;
  const action = form[1].replace(/&amp;/g, "&");
  const params = new URLSearchParams();
  const inputRe = /<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(html)) !== null) {
    params.set(m[1], m[2].replace(/&amp;/g, "&"));
  }
  if (!params.has("id")) return null;
  return `${action}?${params.toString()}`;
}

function tituloDeHtml(html: string): string {
  const m = /<title>([^<]*)<\/title>/.exec(html);
  return m ? m[1].trim().slice(0, 80) : "(sin title)";
}

// Cache en memoria de la URL "confirmada" (drive.usercontent.google.com) de
// los archivos que pasan por el interstitial. Sin esto, CADA pedido de rango
// tendria que volver a bajar y parsear el HTML de confirmacion — y un archivo
// grande se abre con decenas de rangos. La URL trae un uuid con vencimiento,
// asi que se guarda por poco tiempo y se reintenta si deja de servir.
const urlConfirmadaCache = new Map<string, { url: string; expira: number }>();
const TTL_URL_CONFIRMADA = 5 * 60 * 1000;

// Mismo TTL, misma idea: el tamaño total de cada archivo, que es lo que
// permite convertir un rango sufijo a uno absoluto SIN gastar una ida y
// vuelta extra para averiguarlo. Corto a proposito: si Concepts sobreescribe
// el dibujo conservando el id, el total viejo apuntaria al lugar equivocado
// (y aun asi se detecta abajo, comparando contra el Content-Range que vuelve).
const totalesCache = new Map<string, { total: number; expira: number }>();

function totalCacheado(fileId: string): number | null {
  const hit = totalesCache.get(fileId);
  if (hit && hit.expira > Date.now()) return hit.total;
  return null;
}

function recordarTotal(fileId: string, total: number | null): void {
  if (total === null) return;
  totalesCache.set(fileId, { total, expira: Date.now() + TTL_URL_CONFIRMADA });
}

async function resolverUrlDescarga(fileId: string, forzarRefresco = false): Promise<string> {
  const ahora = Date.now();
  if (!forzarRefresco) {
    const hit = urlConfirmadaCache.get(fileId);
    if (hit && hit.expira > ahora) return hit.url;
  }

  const headers = { "User-Agent": "Mozilla/5.0" };
  const directa = `https://drive.google.com/uc?export=download&id=${fileId}`;
  // HEAD no sirve: Drive responde 200 text/html igual. Se pide el primer byte
  // para ver que devuelve sin bajar el archivo entero.
  const sonda = await fetch(directa, {
    headers: { ...headers, Range: "bytes=0-0" },
    signal: AbortSignal.timeout(30000),
  });

  // El caso que se comio tres dias de sospechar de los rangos: Drive contesta
  // 404 (HTML) porque ese fileId YA NO EXISTE — Concepts re-sube el dibujo y
  // Drive le da un id NUEVO, asi que el id viejo que quedo guardado en
  // `drive_folder_cache` apunta a la nada. Antes ese 404 caia en el parseo
  // del interstitial, no encontraba formulario, y salia como
  // "Drive devolvio HTML sin formulario de confirmacion" + 502: un mensaje
  // que apunta al escaneo de virus y no tiene nada que ver.
  if (sonda.status === 404) {
    await sonda.body?.cancel();
    throw new ErrorProxy(404, "drive-404", {
      upstreamStatus: 404,
      detalle:
        "Drive no tiene ese archivo (404). Casi siempre es un id vencido: " +
        "Concepts re-subio el dibujo y Drive le dio uno nuevo. Hay que refrescar el listado de la carpeta.",
    });
  }

  const ct = sonda.headers.get("content-type") || "";
  if (!ct.includes("text/html")) {
    if (!sonda.ok) {
      await sonda.body?.cancel();
      throw new ErrorProxy(502, "upstream", {
        upstreamStatus: sonda.status,
        detalle: `Drive contesto ${sonda.status} al resolver la URL de descarga`,
      });
    }
    recordarTotal(fileId, totalDeContentRange(sonda.headers.get("content-range")));
    await sonda.body?.cancel();
    urlConfirmadaCache.set(fileId, { url: directa, expira: ahora + TTL_URL_CONFIRMADA });
    return directa;
  }

  const html = await sonda.text();
  const confirmUrl = urlDesdeInterstitial(html);
  if (!confirmUrl) {
    throw new ErrorProxy(502, "drive-html", {
      upstreamStatus: sonda.status,
      detalle: `Drive devolvio HTML sin formulario de confirmacion (status ${sonda.status}, titulo "${tituloDeHtml(html)}")`,
    });
  }
  urlConfirmadaCache.set(fileId, { url: confirmUrl, expira: ahora + TTL_URL_CONFIRMADA });
  return confirmUrl;
}

function esHtml(res: Response): boolean {
  return (res.headers.get("content-type") || "").includes("text/html");
}

async function pedirAUrl(url: string, rango: RangoPedido | null): Promise<{ res: Response; url: string }> {
  const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0" };
  if (rango) headers.Range = formatearRango(rango);
  return { res: await fetch(url, { headers, signal: AbortSignal.timeout(120000) }), url };
}

/** Pide el rango resolviendo la URL, y si la respuesta huele a URL vencida
 * (4xx o HTML) re-resuelve el interstitial UNA vez. */
async function pedirResolviendo(
  fileId: string,
  rango: RangoPedido | null,
  urlPrevia: string | null
): Promise<{ res: Response; url: string }> {
  // Camino rapido: el cliente ya sabe la URL directa (se la dimos en un
  // rango anterior), asi que nos ahorramos re-resolver el interstitial —
  // una ida y vuelta extra a Drive por CADA rango pedido.
  let intento = urlPrevia
    ? await pedirAUrl(urlPrevia, rango)
    : await pedirAUrl(await resolverUrlDescarga(fileId, false), rango);

  // Si vencio (Drive devuelve HTML o 4xx), se re-resuelve una vez. Si el
  // archivo ya no existe, `resolverUrlDescarga` tira drive-404 y ese es el
  // error honesto que sale, en vez de un 502 generico.
  if (!intento.res.ok || esHtml(intento.res)) {
    await intento.res.body?.cancel();
    intento = await pedirAUrl(await resolverUrlDescarga(fileId, true), rango);
  }
  return intento;
}

/** Un `bytes=0-0` solo para leer el total del Content-Range. Es la ida y
 * vuelta extra que el camino normal EVITA: solo se paga cuando el upstream
 * no supo servir un rango sufijo. */
async function averiguarTotal(fileId: string, url: string): Promise<number | null> {
  const { res } = await pedirAUrl(url, { tipo: "absoluto", desde: 0, hasta: 0 });
  const total = totalDeContentRange(res.headers.get("content-range"));
  await res.body?.cancel();
  if (total === null) return null;
  recordarTotal(fileId, total);
  return total;
}

// Cuando Drive no honra el Range y manda el archivo entero, a partir de este
// tamaño el detalle del error avisa del egress: encontrado auditando el 14/8/
// 2026, un solo archivo de 275 MB se pidio asi 3.554 veces en 24 horas
// (7,7 GB, mas de una cuota mensual entera del plan Free) pese a tener su
// miniatura ya cacheada en `concept_thumbnails`. Desde R3-01 ese caso se
// corta SIEMPRE con 416 (no solo por encima del techo): devolver el archivo
// entero como respuesta a un rango corre todos los offsets del lector de zip.
const TECHO_RANGE_NO_HONRADO = 8 * 1024 * 1024;

export interface ResultadoDescarga {
  res: Response;
  url: string;
  /** Total del archivo, si se pudo saber. */
  total: number | null;
  /** El rango que efectivamente se le mando a Drive. */
  enviado: RangoPedido | null;
}

/**
 * Descarga (completa o por rango) desde Drive.
 *
 * Los rangos SUFIJO (`bytes=-N`, los ultimos N bytes: el indice del zip) se
 * convierten a absolutos en cuanto se conoce el total del archivo — ver
 * `rangos.ts` para el por que. La primera vez el total no se conoce y se manda
 * el sufijo tal cual (medido: Drive lo honra, y asi se aprende el total de su
 * Content-Range sin gastar un viaje extra); a partir de ahi, y durante el TTL,
 * los rangos salen absolutos.
 */
async function descargarDeDrive(
  fileId: string,
  rango: RangoPedido | null,
  urlPrevia: string | null
): Promise<ResultadoDescarga> {
  let total = totalCacheado(fileId);
  let enviado = rango ? aAbsoluto(rango, total) : null;
  let intento = await pedirResolviendo(fileId, enviado, urlPrevia);

  if (!intento.res.ok) {
    const status = intento.res.status;
    await intento.res.body?.cancel();
    if (status === 416) {
      throw new ErrorProxy(416, "drive-sin-rangos", {
        codigo: CODIGO_RANGO,
        upstreamStatus: 416,
        detalle: `Drive no puede servir ${enviado ? formatearRango(enviado) : "(sin rango)"} (416)`,
      });
    }
    throw new ErrorProxy(status === 404 ? 404 : 502, status === 404 ? "drive-404" : "upstream", {
      upstreamStatus: status,
      detalle: `Drive download ${status}`,
    });
  }
  if (esHtml(intento.res)) {
    await intento.res.body?.cancel();
    throw new ErrorProxy(502, "drive-html", {
      upstreamStatus: intento.res.status,
      detalle: "Drive sigue devolviendo HTML despues de confirmar",
    });
  }

  if (rango) {
    // El total que declara la respuesta manda sobre el cacheado: si el archivo
    // cambio de tamaño conservando el id, el rango absoluto que calculamos
    // apunta al lugar equivocado, y eso se ve ACA (no en el cliente, que ya no
    // tendria como darse cuenta).
    const declarado = totalDeContentRange(intento.res.headers.get("content-range"));
    if (declarado !== null && total !== null && declarado !== total && rango.tipo === "sufijo") {
      await intento.res.body?.cancel();
      total = declarado;
      recordarTotal(fileId, total);
      enviado = aAbsoluto(rango, total);
      intento = await pedirResolviendo(fileId, enviado, intento.url);
    }

    // Drive ignoro el Range: contesto 200 con el archivo entero. Si el rango
    // era un sufijo, todavia queda una carta: averiguar el total y repetir en
    // absoluto, que es la forma que cualquier servidor sabe servir.
    if (intento.res.status !== 206 && enviado?.tipo === "sufijo") {
      await intento.res.body?.cancel();
      total = await averiguarTotal(fileId, intento.url);
      const absoluto = aAbsoluto(rango, total);
      if (absoluto.tipo === "absoluto") {
        enviado = absoluto;
        intento = await pedirResolviendo(fileId, enviado, intento.url);
      }
    }

    if (intento.res.status !== 206) {
      const largo = Number(intento.res.headers.get("content-length") || "0");
      await intento.res.body?.cancel();
      const aviso =
        largo > TECHO_RANGE_NO_HONRADO
          ? ` Son ${(largo / 1e6).toFixed(1)} MB para un pedido de unos pocos bytes: si lo que hace falta es una vista previa, usar la miniatura ya cacheada en concept_thumbnails.`
          : "";
      throw new ErrorProxy(416, "drive-sin-rangos", {
        codigo: CODIGO_RANGO,
        upstreamStatus: intento.res.status,
        detalle:
          `Se pidio ${formatearRango(rango)}${enviado && formatearRango(enviado) !== formatearRango(rango) ? ` (enviado como ${formatearRango(enviado)})` : ""}` +
          ` y Drive contesto ${intento.res.status} con el archivo entero.${aviso}`,
      });
    }
  }

  if (!intento.res.body) {
    throw new ErrorProxy(502, "upstream", {
      upstreamStatus: intento.res.status,
      detalle: "Drive no devolvio contenido",
    });
  }

  const declarado = totalDeContentRange(intento.res.headers.get("content-range"));
  if (declarado !== null) {
    total = declarado;
  } else if (!rango) {
    const len = Number(intento.res.headers.get("content-length") || "0");
    if (len > 0) total = len;
  }
  recordarTotal(fileId, total);

  return { res: intento.res, url: intento.url, total, enviado };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const id = nuevoIdFallo();
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const fileId = url.searchParams.get("fileId");
  // `range` se lee aca arriba (y no dentro del try) para que el cuerpo de
  // error pueda decir QUE se estaba pidiendo: sin eso, el log del fallo no
  // sirve para reproducirlo.
  const rangeParam = url.searchParams.get("range");
  const rangeCrudo = req.headers.get("range") || (rangeParam ? `bytes=${rangeParam}` : null);
  let rangeEnviado: string | null = null;

  const responderError = (err: ErrorProxy): Response => {
    const cuerpo = cuerpoDeError(err, { fileId, range: rangeCrudo, rangeEnviado, id });
    // Los logs de Supabase son lo unico que se puede leer despues de que
    // pasó: la linea lleva lo MISMO que se le devolvio a quien pidio, para
    // poder cruzarlas por el `id`.
    console.error("concepts-drive fallo", JSON.stringify(cuerpo));
    return new Response(JSON.stringify(cuerpo), { status: err.estado, headers: JSON_CORS });
  };

  if (req.method !== "GET") {
    return responderError(new ErrorProxy(405, "pedido-invalido", { detalle: "solo GET" }));
  }

  try {
    if (action === "list") {
      const folderId = url.searchParams.get("folderId") || "";
      if (!folderId) throw new ErrorProxy(400, "pedido-invalido", { detalle: "falta folderId" });
      validarIdDrive(folderId, "folderId");
      const ahora = new Date();
      const [entradas, ivdTimes] = await Promise.all([
        listarCarpetaPublica(folderId),
        fetchIvdModifiedTimes(folderId),
      ]);

      const folders = entradas
        .filter((e) => e.esCarpeta)
        .map((e) => ({ id: e.id, name: e.nombre }));

      const files = entradas
        .filter((e) => !e.esCarpeta)
        .map((e) => {
          const ivdMs = ivdTimes[e.id];
          if (ivdMs) {
            return { id: e.id, name: e.nombre, modifiedAt: new Date(ivdMs).toISOString(), hasTime: true };
          }
          const { iso, hasTime } = parsearFechaModificado(e.modificadoTexto, ahora);
          return { id: e.id, name: e.nombre, modifiedAt: iso, hasTime };
        })
        .sort((a, b) => {
          // Mas reciente primero; sin fecha reconocida va al final.
          if (!a.modifiedAt && !b.modifiedAt) return 0;
          if (!a.modifiedAt) return 1;
          if (!b.modifiedAt) return -1;
          return b.modifiedAt.localeCompare(a.modifiedAt);
        });

      return new Response(JSON.stringify({ ok: true, folders, files }), { headers: JSON_CORS });
    }

    if (action === "download") {
      if (!fileId) throw new ErrorProxy(400, "pedido-invalido", { detalle: "falta fileId" });
      validarIdDrive(fileId, "fileId");

      // El rango puede venir por header (fetch normal) o por query param: el
      // navegador NO deja setear Range a mano en algunos contextos y ademas
      // por query se cachea mejor en el CDN.
      let rango: RangoPedido | null;
      try {
        rango = parsearRango(rangeCrudo);
      } catch (e) {
        if (e instanceof RangoInvalido) {
          throw new ErrorProxy(400, "pedido-invalido", { detalle: e.message });
        }
        throw e;
      }
      const urlPrevia = urlResueltaValida(url.searchParams.get("u"));

      const descarga = await descargarDeDrive(fileId, rango, urlPrevia);
      rangeEnviado = descarga.enviado ? formatearRango(descarga.enviado) : null;
      const upstream = descarga.res;

      const headers: Record<string, string> = {
        ...CORS,
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=3600",
        "Accept-Ranges": "bytes",
        // El cliente la reenvia en los siguientes rangos para saltear la
        // resolucion del interstitial.
        "X-Drive-Url": descarga.url,
      };
      // Pasar el tamaño permite al cliente mostrar progreso de descarga en
      // archivos grandes en vez de quedarse mudo varios segundos.
      const len = upstream.headers.get("content-length");
      if (len) headers["Content-Length"] = len;
      const cr = upstream.headers.get("content-range");
      if (cr) headers["Content-Range"] = cr;
      // El total del archivo va tambien en un header propio: es lo que el
      // lector de zip necesita para ubicar el indice al final, y asi no
      // tiene que parsear Content-Range. Desde R3-01 sale tambien cuando el
      // total se supo por el cache y la respuesta no trajo Content-Range.
      if (descarga.total !== null) headers["X-Drive-Total"] = String(descarga.total);

      return new Response(upstream.body, {
        status: upstream.status === 206 ? 206 : 200,
        headers,
      });
    }

    throw new ErrorProxy(400, "pedido-invalido", { detalle: "action invalida (list|download)" });
  } catch (e) {
    return responderError(comoErrorProxy(e));
  }
});
