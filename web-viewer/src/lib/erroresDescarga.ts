// Mapeo puro de un error de apertura/lectura de un .concepts remoto a un
// codigo del catalogo del centinela (`_Otros_Escuchas/codigos-fallo.json`).
//
// Separado de `VisorConcept/zip.ts` (que arma los mensajes de error y no
// sabe nada del centinela) para que esto sea una funcion pura, sin DOM ni
// red, testeable con node:test tal cual se publica.

/** Detalle util cuando el fallo fue un rango HTTP contra concepts-drive. */
export interface DetalleRangoFallido {
  range: string;
  status: number;
}

// El mismo formato que arma `RemoteSource.fetchRawUnaVez` en zip.ts:
// `Rango bytes=-131072 fallo (502)` o `Rango bytes=1024-2047 fallo (502)`.
const RE_RANGO_FALLIDO = /^Rango (\S+) fallo \((\d+)\)$/;

/** Si el mensaje es el de un rango que le fallo al proxy, separa el rango
 * pedido y el status HTTP que devolvio. Si no, `null`. */
export function parseRangoFallido(mensaje: string): DetalleRangoFallido | null {
  const m = RE_RANGO_FALLIDO.exec(mensaje);
  if (!m) return null;
  return { range: m[1], status: Number(m[2]) };
}

/**
 * Codigo del catalogo que corresponde a un error de `openConceptsRemote` /
 * `parseConceptsRemote` (ver `VisorConcept/parser.ts` y `zip.ts`).
 *
 * UNX-F4005 es el 502 conocido de la Edge Function `concepts-drive` (R3-01
 * lo arregla; esta tarea solo tiene que reportarlo y no colgarse). Los otros
 * dos cubren el resto de lo que ya distingue `zip.ts` por su propio mensaje:
 * archivo demasiado grande para materializar entero (F4001, "descarga
 * incompleta/invalida" en el sentido del catalogo: hubo que bajarlo entero y
 * no entro en el presupuesto) y un indice/encabezado que no se pudo leer
 * (F4002). Cualquier otra cosa (el parser de tree.pack, un msgpack corrupto)
 * cae en F4003.
 */
export function codigoDeErrorDescarga(err: unknown): string {
  const mensaje = err instanceof Error ? err.message : String(err);
  if (parseRangoFallido(mensaje)) return "UNX-F4005";
  if (/da[ñn]ado, incompleto, o el servidor no soporta descarga parcial/i.test(mensaje)) {
    return "UNX-F4001";
  }
  if (/Encabezado da[ñn]ado|no parece un archivo \.concepts v[aá]lido/i.test(mensaje)) {
    return "UNX-F4002";
  }
  return "UNX-F4003";
}
