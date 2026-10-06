// Cableado real del "sistema de llamados" (la logica vive en transporteCore.ts,
// que no toca la red). Aca se conecta con Supabase, con el tunel y con la URL.
//
// Uso (los tres lugares que leen un dibujo: abrirlo en el visor, la miniatura
// de la galeria y el exportar):
//
//   const f = await fuenteParaArchivo(fileId);
//   const archivo = await openConceptsRemote(f.url, f.headers, { directa: f.directa, ... });
//
// Al cargar la pagina se sondea el tunel UNA vez (`iniciarSondeo`, no bloquea
// nada). Si el tunel no sirve, `fuenteParaArchivo` devuelve la fuente de Drive
// de siempre. Nunca rechaza.
//
// Interruptores por URL (sirven para medir y como freno de mano):
//   ?transporte=drive   no usar nunca el tunel
//   ?transporte=tunel   no bajar el modo aunque el tunel falle (para probar)
// Solo en desarrollo:
//   ?nodoApi=<url>      base de la funcion `concepts-nodo` (una local, por ej.)

import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from "../config";
import { driveAuthHeaders, driveFileUrl } from "./driveClient";
import { fetchAllFolderCache } from "./supabaseClient";
import type { FuenteDirecta } from "../VisorConcept/zip";
import {
  crearTransporte,
  localizarEnArbol,
  type Dependencias,
  type FilaArbol,
  type Modo,
  type Salud,
} from "./transporteCore";

export type { Modo };

function parametro(nombre: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(nombre);
  } catch {
    return null;
  }
}

function baseFuncion(): string {
  if (import.meta.env.DEV) {
    const local = parametro("nodoApi");
    if (local) return local.replace(/\/+$/, "");
  }
  return `${FUNCTIONS_URL}/concepts-nodo`;
}

const dependencias: Dependencias = {
  async llamarFuncion<T>(accion: string, params: Record<string, string>, topeMs: number): Promise<T> {
    const q = new URLSearchParams({ action: accion, ...params });
    const res = await fetch(`${baseFuncion()}?${q}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      signal: AbortSignal.timeout(topeMs),
    });
    // Un 400 trae `{ok:false, motivo}` (ruta invalida): es una respuesta, no una falla de red.
    if (!res.ok && res.status !== 400) {
      await res.body?.cancel();
      throw new Error(`concepts-nodo ${res.status}`);
    }
    return (await res.json()) as T;
  },
  async pedirSalud(tunelUrl: string, topeMs: number): Promise<Salud> {
    const res = await fetch(`${tunelUrl.replace(/\/+$/, "")}/salud`, {
      cache: "no-store",
      signal: AbortSignal.timeout(topeMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`salud ${res.status}`);
    }
    return (await res.json()) as Salud;
  },
  fuenteDrive: (fileId: string) => ({ url: driveFileUrl(fileId), headers: driveAuthHeaders() }),
  ahora: () => Date.now(),
  forzado: () => {
    const v = parametro("transporte");
    return v === "drive" || v === "tunel" ? v : null;
  },
};

const transporte = crearTransporte(dependencias);

/** Foto del estado para depurar desde la consola o desde un arnes. */
if (typeof window !== "undefined") {
  (window as unknown as { __transporte?: () => unknown }).__transporte = () => transporte.instantanea();
}

/** Arranca el sondeo del tunel. Llamarlo al cargar la pagina; es idempotente. */
export const iniciarSondeo = transporte.iniciarSondeo;
export const estadoDelTransporte = transporte.estadoActual;

// El arbol de carpetas ya viene cacheado en Supabase (la galeria lo usa para
// navegar). Se pide una vez y se reusa un rato: abrir 20 miniaturas no debe
// bajar 20 veces el arbol entero.
const VIGENCIA_ARBOL_MS = 5 * 60_000;
let arbolEnMemoria: { cuando: number; arbol: Promise<Map<string, FilaArbol>> } | null = null;

function arbol(): Promise<Map<string, FilaArbol>> {
  if (arbolEnMemoria && Date.now() - arbolEnMemoria.cuando < VIGENCIA_ARBOL_MS) return arbolEnMemoria.arbol;
  const p = fetchAllFolderCache() as Promise<Map<string, FilaArbol>>;
  arbolEnMemoria = { cuando: Date.now(), arbol: p };
  p.catch(() => {
    if (arbolEnMemoria?.arbol === p) arbolEnMemoria = null;
  });
  return p;
}

export interface FuenteLista {
  origen: Modo;
  /** Por que se eligio (`ok`, `sin-nodos`, `nodo-desactualizado`, ...). */
  motivo: string;
  url: string;
  headers: Record<string, string>;
  /** Presente solo si la fuente es el tunel. */
  directa?: FuenteDirecta;
}

/** La fuente de Drive de siempre, para cuando quien llama ya sabe que el tunel no sirvio. */
export function fuenteDeDrive(fileId: string, motivo: string): FuenteLista {
  const d = dependencias.fuenteDrive(fileId);
  return { origen: "drive", motivo, url: d.url, headers: d.headers };
}

/**
 * De donde leer el dibujo `fileId`. Si la ruta no se puede deducir del arbol
 * cacheado, o cualquier eslabon del tunel falla, devuelve Drive.
 *
 * `alConmutar` se llama si el tunel se cae a mitad de la lectura y se sigue
 * con Drive (para que quien mide pueda registrarlo).
 */
export async function fuenteParaArchivo(fileId: string, alConmutar?: (motivo: string) => void): Promise<FuenteLista> {
  const drive = dependencias.fuenteDrive(fileId);
  const comoDrive = (motivo: string): FuenteLista => ({ origen: "drive", motivo, url: drive.url, headers: drive.headers });

  if (dependencias.forzado() === "drive") return comoDrive("forzado");

  let ubicado: ReturnType<typeof localizarEnArbol> = null;
  try {
    ubicado = localizarEnArbol(await arbol(), fileId);
  } catch {
    return comoDrive("arbol-no-disponible");
  }
  if (!ubicado) return comoDrive("archivo-fuera-del-arbol");

  const f = await transporte.resolverFuente({
    fileId,
    nombre: ubicado.nombre,
    ruta: ubicado.ruta,
    modifiedAt: ubicado.modifiedAt,
    hasTime: ubicado.hasTime,
  });
  if (f.origen === "drive") return comoDrive(f.motivo);

  return {
    origen: "tunel",
    motivo: f.motivo,
    url: f.url,
    headers: f.headers,
    directa: {
      size: f.size!,
      renovar: f.renovar,
      alternativa: f.alternativa,
      onConmutar: (motivo) => {
        // El tunel fallo en plena lectura: ademas de seguir con Drive para este
        // dibujo, los siguientes ni lo intentan hasta la proxima sonda.
        transporte.marcarCaido(`lectura:${motivo}`);
        transporte.anotarConmutacion({ fileId, motivo });
        alConmutar?.(motivo);
      },
    },
  };
}

/**
 * Corre `usar` con la mejor fuente y, si falla leyendo del TUNEL (zip ilegible
 * por una copia a medio sincronizar, cualquier error que el lector no pudo
 * resolver solo), lo repite UNA vez con Drive. Un error leyendo de Drive sube
 * tal cual: no hay un tercer lugar donde probar.
 *
 * Sirve para los lugares que abren un dibujo, lo usan y lo cierran (miniatura
 * de la galeria, exportar). El visor tiene su propio camino porque el
 * documento sigue leyendose despues de abrirlo.
 */
export async function conRespaldoDrive<T>(fileId: string, usar: (fuente: FuenteLista) => Promise<T>): Promise<T> {
  const fuente = await fuenteParaArchivo(fileId);
  if (fuente.origen !== "tunel") return usar(fuente);
  try {
    return await usar(fuente);
  } catch {
    return usar(fuenteDeDrive(fileId, "respaldo-lectura"));
  }
}
