// Firmante de los llamados al nodo (la PC con `_FilesSync` y su tunel de
// Cloudflare) para leer los .concepts de C:\ARQ\BIM\Concepts directo, sin
// pasar por Drive.
//
// La galeria (navegador) NO puede firmar: el secreto de la flota no puede
// viajar en el bundle. Esta funcion lo tiene como secret
// (`UNX_NODO_TOKEN`, el mismo valor que usa W_07_Files) y entrega:
//
//   ?action=estado
//     -> { ok, firma, nodo: { id, tunelUrl } | null, motivo? }
//        Sirve para que el navegador sepa a donde sondear `/salud`. No firma
//        nada, asi que anda aunque el secret no este cargado (`firma:false`).
//
//   ?action=firmar&ruta=Guada y Flor Re/Concepts/.../Dibujo.concepts
//     -> { ok:true, url, size, mtimeMs, expiraEnMs, nodoId }
//        `url` es un `/descargar` firmado, valido para ESA ruta por 10 min.
//        `size` y `mtimeMs` salen de listar la carpeta en el nodo: el
//        navegador los necesita porque el tunel no expone `Content-Range`
//        por CORS (sin eso no se sabe el tamaño de un rango) y para decidir
//        si la copia local esta al dia con la de Drive.
//     -> { ok:false, motivo } cuando no se puede (el cliente cae a Drive).
//
// Toda negativa sale como HTTP 200 + `ok:false` + `motivo`: "no hay nodo" no
// es un error del pedido, es una respuesta normal que dispara el respaldo.
// Solo un pedido mal formado es 400.
//
// Desplegada en Supabase (proyecto kuhcxzusnrttkywgalgk). No se autodespliega
// desde este archivo: hay que redesplegar los TRES (`index.ts`, `ruta.ts`,
// `firma.ts`) con deploy_edge_function. Secret: `UNX_NODO_TOKEN`.

import { firmarDescarga, firmarPedido } from "./firma.ts";
import { RutaInvalida, rutaAbsolutaEnNodo, segmentosDeConcept } from "./ruta.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const JSON_CORS = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };

/** Igual que `HEARTBEAT_TOLERANCIA_MS` de @unx/contratos (3 latidos de 20 s). */
const HEARTBEAT_TOLERANCIA_MS = 60_000;
/** Cuanto vale un permiso. El lector pide rangos durante toda la sesion de un
 * dibujo; el cliente renueva antes de que venza. */
const VIGENCIA_PERMISO_MS = 10 * 60_000;
const TOPE_NODO_MS = 5_000;
const POR_PAGINA = 30;
const MAX_PAGINAS = 10;

interface NodoFlota {
  id: string;
  nombre: string;
  activo: boolean;
  modo: string;
  tunel_url: string | null;
  ultimo_heartbeat: string | null;
}

function responder(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: JSON_CORS });
}

function negativa(motivo: string, extra: Record<string, unknown> = {}): Response {
  return responder({ ok: false, motivo, ...extra });
}

/** Nodos vivos, el de latido mas reciente primero. Misma regla que `evaluarFlota`. */
async function nodosVivos(): Promise<NodoFlota[]> {
  const base = Deno.env.get("SUPABASE_URL");
  const clave = Deno.env.get("SUPABASE_ANON_KEY");
  if (!base || !clave) throw new Error("sin SUPABASE_URL/SUPABASE_ANON_KEY");
  const r = await fetch(`${base}/rest/v1/rpc/unx_estado_flota`, {
    method: "POST",
    headers: { apikey: clave, Authorization: `Bearer ${clave}`, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(TOPE_NODO_MS),
  });
  if (!r.ok) throw new Error(`unx_estado_flota ${r.status}`);
  const nodos = (await r.json()) as NodoFlota[];
  const ahora = Date.now();
  return nodos
    .filter((n) => {
      const hb = n.ultimo_heartbeat ? new Date(n.ultimo_heartbeat).getTime() : NaN;
      return n.activo && n.modo !== "bloqueado" && !!n.tunel_url && Number.isFinite(hb) && ahora - hb <= HEARTBEAT_TOLERANCIA_MS;
    })
    .sort((a, b) => new Date(b.ultimo_heartbeat!).getTime() - new Date(a.ultimo_heartbeat!).getTime());
}

interface Salud {
  ok: boolean;
  operativo: boolean;
  transporte?: string;
  carpetaCompartida?: string;
  interruptorActivo?: boolean;
}

async function saludDe(tunel: string): Promise<Salud | null> {
  try {
    const r = await fetch(`${tunel.replace(/\/$/, "")}/salud`, { signal: AbortSignal.timeout(TOPE_NODO_MS) });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    return (await r.json()) as Salud;
  } catch {
    return null;
  }
}

function saludSirve(s: Salud | null): s is Salud & { carpetaCompartida: string } {
  return (
    !!s &&
    s.ok === true &&
    s.operativo === true &&
    s.interruptorActivo !== true &&
    typeof s.carpetaCompartida === "string" &&
    s.carpetaCompartida.length > 0
  );
}

/** Primer nodo vivo cuyo `/salud` contesta de verdad (el latido puede ser de
 * un tunel que ya murio: ver bug #4 de docs/SERVICIO.md de W_07). */
type Elegido = { nodo: NodoFlota; salud: Salud & { carpetaCompartida: string } };

/** El nodo sano se recuerda unos segundos: sin esto CADA firma repetia flota +
 * /salud (dos saltos de red) antes de hacer lo suyo. Solo se cachean aciertos:
 * una caida se vuelve a ver en el siguiente pedido. */
const VIGENCIA_NODO_MS = 20_000;
let nodoRecordado: { hasta: number; valor: Elegido } | null = null;

async function nodoElegido(): Promise<Elegido | { motivo: string }> {
  if (nodoRecordado && nodoRecordado.hasta > Date.now()) return nodoRecordado.valor;
  const r = await buscarNodo();
  if (!("motivo" in r)) nodoRecordado = { hasta: Date.now() + VIGENCIA_NODO_MS, valor: r };
  else nodoRecordado = null;
  return r;
}

async function buscarNodo(): Promise<Elegido | { motivo: string }> {
  let vivos: NodoFlota[];
  try {
    vivos = await nodosVivos();
  } catch (e) {
    console.error("[concepts-nodo] flota", String(e));
    return { motivo: "flota-no-responde" };
  }
  if (vivos.length === 0) return { motivo: "sin-nodos" };
  for (const nodo of vivos.slice(0, 2)) {
    const salud = await saludDe(nodo.tunel_url!);
    if (saludSirve(salud)) return { nodo, salud };
  }
  return { motivo: "tunel-no-responde" };
}

interface FilaListado {
  nombre: string;
  tamano_bytes: number;
  fecha_modificacion: string;
  es_carpeta: boolean;
}

/** Tamaño y mtime del archivo, leidos del nodo. Tambien prueba que EXISTE. */
async function datosDelArchivo(
  tunel: string,
  secreto: string,
  carpeta: string,
  nombre: string,
): Promise<{ size: number; mtimeMs: number } | "no-esta" | "listar-fallo"> {
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const exp = Date.now() + 60_000;
    const sig = await firmarPedido(secreto, "POST", "/listar", exp);
    let r: Response;
    try {
      r = await fetch(`${tunel.replace(/\/$/, "")}/listar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Unx-Exp": String(exp), "X-Unx-Sig": sig },
        body: JSON.stringify({ carpeta, pagina, porPagina: POR_PAGINA, orden: "nombre", ascendente: true }),
        signal: AbortSignal.timeout(TOPE_NODO_MS),
      });
    } catch {
      return "listar-fallo";
    }
    if (r.status === 404) {
      await r.body?.cancel();
      return "no-esta";
    }
    if (!r.ok) {
      await r.body?.cancel();
      return "listar-fallo";
    }
    const cuerpo = (await r.json()) as { resultados: FilaListado[]; total: number };
    const fila = cuerpo.resultados.find((f) => !f.es_carpeta && f.nombre === nombre);
    if (fila) return { size: fila.tamano_bytes, mtimeMs: new Date(fila.fecha_modificacion).getTime() };
    if ((pagina + 1) * POR_PAGINA >= cuerpo.total) return "no-esta";
  }
  return "no-esta";
}

async function accionEstado(): Promise<Response> {
  const secreto = Deno.env.get("UNX_NODO_TOKEN");
  const elegido = await nodoElegido();
  if ("motivo" in elegido) return responder({ ok: true, firma: !!secreto, nodo: null, motivo: elegido.motivo });
  return responder({
    ok: true,
    firma: !!secreto,
    nodo: { id: elegido.nodo.id, tunelUrl: elegido.nodo.tunel_url!.replace(/\/$/, "") },
  });
}

async function accionFirmar(url: URL): Promise<Response> {
  const secreto = Deno.env.get("UNX_NODO_TOKEN");
  if (!secreto) return negativa("sin-firma");

  let segmentos: string[];
  try {
    segmentos = segmentosDeConcept(url.searchParams.get("ruta") ?? "");
  } catch (e) {
    if (e instanceof RutaInvalida) return responder({ ok: false, motivo: "ruta-invalida", detalle: e.message }, 400);
    throw e;
  }

  const elegido = await nodoElegido();
  if ("motivo" in elegido) return negativa(elegido.motivo);
  const tunel = elegido.nodo.tunel_url!.replace(/\/$/, "");

  const { archivo, carpeta } = rutaAbsolutaEnNodo(elegido.salud.carpetaCompartida, segmentos);
  const datos = await datosDelArchivo(tunel, secreto, carpeta, segmentos[segmentos.length - 1]);
  if (datos === "no-esta") return negativa("no-esta-en-nodo");
  if (datos === "listar-fallo") {
    nodoRecordado = null;
    return negativa("nodo-rechazo");
  }

  const expiraEnMs = Date.now() + VIGENCIA_PERMISO_MS;
  const sig = await firmarDescarga(secreto, archivo, expiraEnMs);
  const destino = new URL(`${tunel}/descargar`);
  destino.searchParams.set("ruta", archivo);
  destino.searchParams.set("exp", String(expiraEnMs));
  destino.searchParams.set("sig", sig);
  return responder({
    ok: true,
    url: destino.toString(),
    size: datos.size,
    mtimeMs: datos.mtimeMs,
    expiraEnMs,
    nodoId: elegido.nodo.id,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return responder({ ok: false, motivo: "metodo" }, 405);
  const url = new URL(req.url);
  try {
    switch (url.searchParams.get("action")) {
      case "estado":
        return await accionEstado();
      case "firmar":
        return await accionFirmar(url);
      default:
        return responder({ ok: false, motivo: "accion-invalida" }, 400);
    }
  } catch (e) {
    console.error("[concepts-nodo] interno", String(e));
    return negativa("interno");
  }
});
