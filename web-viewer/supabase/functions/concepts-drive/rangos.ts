// Rangos HTTP: parseo, conversion sufijo -> absoluto y lectura del total.
//
// Por que existe. El lector de zip pide los ultimos 128 KB con un rango
// SUFIJO (`bytes=-131072`): ahi vive el indice del .concepts, y pedirlo asi
// trae el indice Y el tamaño total en una sola ida y vuelta (cada una cuesta
// ~1,7 s contra Drive). Medido el 13/09/2026: Drive HOY honra el sufijo, en
// la URL directa y en la confirmada del interstitial (206 + `Content-Range:
// bytes 275525185-275656256/275656257` en el archivo de 262 MB).
//
// Pero un sufijo es lo primero que un CDN o un proxy deja de honrar, y
// cuando eso pasa la respuesta es un 200 con el archivo entero — que, si se
// devolviera como si fuera un 206, corre TODOS los offsets del lector de zip
// y hace que el dibujo "se abra mal" en vez de fallar. Por eso, en cuanto se
// conoce el total del archivo, el sufijo se convierte a un rango absoluto
// equivalente, que es la forma que todo el mundo sabe servir.

export interface RangoSufijo {
  tipo: "sufijo";
  /** Cuantos bytes del final se piden. Siempre > 0. */
  n: number;
}

export interface RangoAbsoluto {
  tipo: "absoluto";
  desde: number;
  /** `null` es `bytes=<desde>-`, o sea "hasta el final". */
  hasta: number | null;
}

export type RangoPedido = RangoSufijo | RangoAbsoluto;

/** Se tira cuando el Range del cliente no se entiende: es un 400, no un 502.
 * `index.ts` lo convierte en ErrorProxy; aca no se importa nada para que este
 * modulo siga siendo puro y testeable sin el runtime. */
export class RangoInvalido extends Error {
  constructor(valor: string) {
    super(`Range invalido: ${valor.slice(0, 80)}`);
    this.name = "RangoInvalido";
  }
}

const RE_SUFIJO = /^bytes=-(\d+)$/;
const RE_ABSOLUTO = /^bytes=(\d+)-(\d*)$/;

/**
 * Interpreta el valor de un header `Range`. `null` (o vacio) significa "sin
 * rango": el pedido es del archivo entero, que es legitimo.
 *
 * Solo se acepta UN rango de bytes. Los multi-rango (`bytes=0-9,20-29`) no se
 * soportan a proposito: el lector de zip nunca los pide, y proxyearlos exige
 * armar un multipart/byteranges que nadie de este lado sabe leer.
 */
export function parsearRango(valor: string | null | undefined): RangoPedido | null {
  if (!valor) return null;
  const v = valor.trim();

  const suf = RE_SUFIJO.exec(v);
  if (suf) {
    const n = Number(suf[1]);
    // `bytes=-0` no pide nada: por RFC 9110 no es satisfacible.
    if (!Number.isSafeInteger(n) || n <= 0) throw new RangoInvalido(v);
    return { tipo: "sufijo", n };
  }

  const abs = RE_ABSOLUTO.exec(v);
  if (abs) {
    const desde = Number(abs[1]);
    const hasta = abs[2] === "" ? null : Number(abs[2]);
    if (!Number.isSafeInteger(desde) || desde < 0) throw new RangoInvalido(v);
    if (hasta !== null && (!Number.isSafeInteger(hasta) || hasta < desde)) throw new RangoInvalido(v);
    return { tipo: "absoluto", desde, hasta };
  }

  throw new RangoInvalido(v);
}

/** El valor de header que corresponde a un rango ya interpretado. */
export function formatearRango(r: RangoPedido): string {
  if (r.tipo === "sufijo") return `bytes=-${r.n}`;
  return `bytes=${r.desde}-${r.hasta === null ? "" : r.hasta}`;
}

/**
 * Sufijo -> absoluto, si se conoce el total.
 *
 * Sin total devuelve el rango tal cual: pedir el sufijo es preferible a
 * inventar un offset, y de la respuesta se aprende el total para la proxima
 * (ver `totalDeContentRange`). Un rango que ya es absoluto no se toca.
 */
export function aAbsoluto(r: RangoPedido, total: number | null): RangoPedido {
  if (r.tipo !== "sufijo") return r;
  if (total === null || !Number.isSafeInteger(total) || total <= 0) return r;
  return { tipo: "absoluto", desde: Math.max(0, total - r.n), hasta: total - 1 };
}

/** El total que declara un `Content-Range: bytes <a>-<b>/<total>`. `*` como
 * total (que es lo que manda un 416) no dice nada: devuelve `null`. */
export function totalDeContentRange(cr: string | null | undefined): number | null {
  if (!cr) return null;
  const m = /\/(\d+)\s*$/.exec(cr);
  if (!m) return null;
  const total = Number(m[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/** Cuantos bytes deberia traer un rango, con el total conocido. Sirve para
 * darse cuenta de que el upstream ignoro el Range aunque haya contestado 206
 * (mando de mas). `null` cuando no se puede saber. */
export function bytesEsperados(r: RangoPedido | null, total: number | null): number | null {
  if (!r) return total;
  if (r.tipo === "sufijo") return total === null ? null : Math.min(r.n, total);
  const hasta = r.hasta ?? (total === null ? null : total - 1);
  if (hasta === null) return null;
  return hasta - r.desde + 1;
}
