// Contrato de error de `concepts-drive`.
//
// Hasta R3-01 CUALQUIER fallo salia igual: status 502 y cuerpo
// `{ok:false, error:"<String(e)>"}`. Con eso, "el archivo ya no existe en
// Drive" (un id vencido en el cache de carpetas) y "Drive se cayo" eran
// indistinguibles desde afuera, y la unica pista que llegaba a quien miraba
// era `Drive devolvio HTML sin formulario de confirmacion` — un mensaje que
// apunta al interstitial de virus cuando en realidad Drive habia contestado
// un 404. Tres dias de sospechar de los rangos sufijo salieron de ahi.
//
// Ahora cada fallo lleva:
//   - `codigo`: uno del catalogo del parque (_Otros_Escuchas/codigos-fallo.json),
//     para poder contarlo junto al resto sin traducir;
//   - `causa`: una etiqueta CORTA y estable, que es por lo que se grepea;
//   - `detalle`: el mensaje original recortado, que es lo que se lee;
//   - `id`: lo unico que enlaza lo que ve la persona en pantalla con la linea
//     de `console.error` en los logs de Supabase (los unicos que se pueden
//     leer despues de que pasó).
// Y el status dice de quien fue: 400 pedido invalido, 404 el archivo no esta,
// 416 el rango no se puede servir, 502 el upstream.

/** La Edge Function contesto con un cuerpo de error (categoria backend). */
export const CODIGO_EDGE = "UNX-F7001";
/** El pedido por rango no se pudo servir; el cliente tiene que caer a la
 * descarga completa a proposito. */
export const CODIGO_RANGO = "UNX-F4005";

/**
 * Etiquetas estables de causa. Cortas a proposito: son lo que se busca en los
 * logs y lo que el cliente compara para decidir que hacer.
 *
 * - `pedido-invalido`: falta un parametro, el id no tiene forma de id de Drive
 *   o el Range no se entiende. Culpa del pedido, no de Drive.
 * - `drive-404`: Drive contesta 404 para ese fileId. En esta carpeta el caso
 *   real es que Concepts re-subio el dibujo y Drive le dio un id NUEVO: el id
 *   viejo quedo muerto en `drive_folder_cache` y el cliente lo sigue pidiendo.
 * - `drive-sin-rangos`: se pidio un rango y Drive contesto 200 con el archivo
 *   entero. NO se devuelve ese 200 como si fuera un 206: seria corromper los
 *   offsets del lector de zip.
 * - `drive-html`: Drive sigue devolviendo HTML despues de confirmar el
 *   interstitial de virus (formato de la pagina cambiado, o cuota).
 * - `timeout`: vencio uno de los AbortSignal contra Drive.
 * - `upstream`: cualquier otro status feo de Drive.
 * - `interno`: se rompio esta funcion. Si aparece, es un bug de acá.
 */
export type CausaProxy =
  | "pedido-invalido"
  | "drive-404"
  | "drive-sin-rangos"
  | "drive-html"
  | "timeout"
  | "upstream"
  | "interno";

export interface OpcionesErrorProxy {
  /** Por defecto CODIGO_EDGE; los fallos de rango llevan CODIGO_RANGO. */
  codigo?: string;
  /** El status que contesto Drive, cuando lo hubo. */
  upstreamStatus?: number | null;
  /** Mensaje largo para el detalle; por defecto se arma con la causa. */
  detalle?: string;
}

export class ErrorProxy extends Error {
  readonly estado: number;
  readonly codigo: string;
  readonly causa: CausaProxy;
  readonly upstreamStatus: number | null;
  readonly detalle: string;

  constructor(estado: number, causa: CausaProxy, opciones: OpcionesErrorProxy = {}) {
    const detalle = opciones.detalle ?? causa;
    super(detalle);
    this.name = "ErrorProxy";
    this.estado = estado;
    this.causa = causa;
    this.codigo = opciones.codigo ?? (causa === "drive-sin-rangos" ? CODIGO_RANGO : CODIGO_EDGE);
    this.upstreamStatus = opciones.upstreamStatus ?? null;
    this.detalle = detalle;
  }
}

/**
 * Traduce cualquier cosa que haya caido en el catch a un ErrorProxy.
 *
 * Los timeouts se distinguen a proposito: `AbortSignal.timeout` tira un
 * DOMException llamado `TimeoutError`, y sin separarlo "Drive tarda" se ve
 * igual que "Drive contesta mal" — que se arreglan de forma distinta.
 */
export function comoErrorProxy(e: unknown): ErrorProxy {
  if (e instanceof ErrorProxy) return e;
  const mensaje = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const esTimeout =
    (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) ||
    /timed? ?out|aborted/i.test(mensaje);
  return new ErrorProxy(502, esTimeout ? "timeout" : "interno", { detalle: mensaje });
}

export interface ContextoError {
  fileId: string | null;
  /** El rango tal como lo pidio el cliente. */
  range: string | null;
  /** El rango que efectivamente se le mando a Drive, si difiere del pedido. */
  rangeEnviado?: string | null;
  /** Identificador corto de este fallo; el mismo que se loguea. */
  id: string;
}

export interface CuerpoError {
  ok: false;
  codigo: string;
  causa: CausaProxy;
  detalle: string;
  upstreamStatus: number | null;
  fileId: string | null;
  range: string | null;
  rangeEnviado?: string;
  id: string;
  /** Se mantiene por compatibilidad: clientes viejos leen `error`. */
  error: string;
}

/** El cuerpo JSON de un fallo. Es exactamente lo mismo que se escribe con
 * console.error, para que la fila del log y lo que vio la persona se puedan
 * cruzar por el `id`. */
export function cuerpoDeError(err: ErrorProxy, ctx: ContextoError): CuerpoError {
  const cuerpo: CuerpoError = {
    ok: false,
    codigo: err.codigo,
    causa: err.causa,
    detalle: err.detalle.slice(0, 300),
    upstreamStatus: err.upstreamStatus,
    fileId: ctx.fileId,
    range: ctx.range,
    id: ctx.id,
    error: err.detalle.slice(0, 300),
  };
  if (ctx.rangeEnviado && ctx.rangeEnviado !== ctx.range) cuerpo.rangeEnviado = ctx.rangeEnviado;
  return cuerpo;
}

/** Id corto de fallo. Ocho hex alcanzan: sirve para encontrar UNA linea en los
 * logs de las ultimas horas, no para ser unico en el universo. */
export function nuevoIdFallo(): string {
  return crypto.randomUUID().slice(0, 8);
}
