// Traduce "el dibujo que la galeria quiere abrir" a la ruta del disco del
// nodo, y rechaza todo lo que no sea un .concepts dentro de BIM\Concepts.
//
// Este es el UNICO filtro entre un pedido publico (la anon key vive en el
// bundle) y la firma que abre un archivo de C:\ARQ: si una ruta pasa de aca,
// se firma. Por eso es estricto y chico, y tiene sus propios tests.

/** Subcarpeta del root compartido donde viven los dibujos. */
export const SUBCARPETA_CONCEPTS = ["BIM", "Concepts"] as const;

/** Un segmento es un nombre de carpeta/archivo, nunca una ruta. */
// eslint-disable-next-line no-control-regex
const SEGMENTO_INVALIDO = /[\\/:*?"<>|\u0000-\u001f]/;

export class RutaInvalida extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "RutaInvalida";
  }
}

/**
 * `ruta` llega con "/" entre segmentos, sin la raiz de Drive:
 * `Guada y Flor Re/Concepts/ROOSEVELT 4464/3er piso/RO 3er y 4to..concepts`.
 * Devuelve los segmentos validados (carpetas + archivo).
 */
export function segmentosDeConcept(ruta: string): string[] {
  if (typeof ruta !== "string" || ruta.length === 0 || ruta.length > 1024) {
    throw new RutaInvalida("ruta vacia o demasiado larga");
  }
  const segmentos = ruta.split("/");
  if (segmentos.length > 12) throw new RutaInvalida("profundidad invalida");

  const archivo = segmentos[segmentos.length - 1];
  if (!archivo.toLowerCase().endsWith(".concepts")) throw new RutaInvalida("solo se firman archivos .concepts");

  segmentos.forEach((s, i) => {
    if (s.length === 0 || s.length > 255) throw new RutaInvalida("segmento vacio o largo");
    // "." y ".." escapan de la carpeta.
    if (s === "." || s === "..") throw new RutaInvalida("segmento no permitido");
    // Windows descarta el punto o el espacio final de una CARPETA y abre otra
    // distinta; el archivo ya esta cubierto por la extension.
    const esCarpeta = i < segmentos.length - 1;
    if (esCarpeta && /[. ]$/.test(s)) throw new RutaInvalida("carpeta con punto o espacio final");
    if (SEGMENTO_INVALIDO.test(s)) throw new RutaInvalida("caracter no permitido");
  });
  return segmentos;
}

/** Une con "\" bajo el root del nodo (`C:\ARQ`): la forma que valida el nodo. */
export function rutaAbsolutaEnNodo(carpetaCompartida: string, segmentos: string[]): { archivo: string; carpeta: string } {
  const raiz = carpetaCompartida.replace(/[\\/]+$/, "");
  if (raiz.length === 0 || raiz.length > 512) throw new RutaInvalida("root del nodo invalido");
  const carpeta = [raiz, ...SUBCARPETA_CONCEPTS, ...segmentos.slice(0, -1)].join("\\");
  const archivo = carpeta + "\\" + segmentos[segmentos.length - 1];
  return { archivo, carpeta };
}
