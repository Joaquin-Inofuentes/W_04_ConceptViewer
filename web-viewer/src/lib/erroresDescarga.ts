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

/** El cuerpo de error que devuelve `concepts-drive` desde R3-01. `zip.ts` lo
 * adjunta al Error (clase `ErrorProxyConcepts`); aca se lee de forma
 * estructural para no acoplar este modulo puro con el del zip. */
export interface DetalleProxy {
  status: number;
  range: string | null;
  codigo: string | null;
  causa: string | null;
  idFallo: string | null;
}

/** Si el error viene del proxy con el contrato de R3-01, devuelve sus campos.
 * `null` si es cualquier otro error. */
export function detalleProxy(err: unknown): DetalleProxy | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  if (e.name !== "ErrorProxyConcepts" || typeof e.status !== "number") return null;
  return {
    status: e.status,
    range: typeof e.range === "string" ? e.range : null,
    codigo: typeof e.codigo === "string" ? e.codigo : null,
    causa: typeof e.causa === "string" ? e.causa : null,
    idFallo: typeof e.idFallo === "string" ? e.idFallo : null,
  };
}

/**
 * Codigo del catalogo que corresponde a un error de `openConceptsRemote` /
 * `parseConceptsRemote` (ver `VisorConcept/parser.ts` y `zip.ts`).
 *
 * Desde R3-01 la Edge Function manda su propio `codigo` en el cuerpo del
 * error, y ese manda: es la funcion la que sabe si fue un rango (UNX-F4005)
 * o cualquier otro fallo suyo (UNX-F7001, "la Edge Function contesto un
 * error" — el caso real es un fileId que ya no existe en Drive).
 *
 * Sin ese cuerpo se sigue deduciendo del mensaje, como antes: UNX-F4005 para
 * un rango fallido; archivo demasiado grande para materializar entero (F4001,
 * "descarga incompleta/invalida" en el sentido del catalogo: hubo que bajarlo
 * entero y no entro en el presupuesto); indice/encabezado que no se pudo leer
 * (F4002). Cualquier otra cosa (el parser de tree.pack, un msgpack corrupto)
 * cae en F4003.
 */
export function codigoDeErrorDescarga(err: unknown): string {
  const delProxy = detalleProxy(err);
  if (delProxy?.codigo) return delProxy.codigo;
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
