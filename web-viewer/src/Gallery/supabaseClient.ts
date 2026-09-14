/**
 * Acceso a Supabase por REST directo (PostgREST), sin el SDK.
 *
 * El SDK `@supabase/supabase-js` pesa ~33 KB gzip y trae realtime, auth y
 * storage — nada de lo cual se usa aca: los cuatro accesos son un select con
 * filtro `in`, dos upserts y un insert, o sea llamadas HTTP con dos headers.
 * En una conexion 3G de un telefono viejo, esos 33 KB son medio segundo de
 * arranque regalado.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, THUMBNAIL_SIZE } from "../config";
import type { DriveFolderRef, DriveFile } from "./driveClient";
import { cacheDeCarpetaVencido, TTL_CACHE_CARPETA_MS } from "./cacheFrescura";

// Re-exportados para que el resto del codigo (Gallery.tsx) siga importando
// todo lo del cache de carpetas desde este archivo; la logica en si vive en
// `cacheFrescura.ts` porque es pura y necesita poder testearse con
// `node --test` sin arrastrar `../config` (ver el comentario de ese archivo).
export { cacheDeCarpetaVencido, TTL_CACHE_CARPETA_MS };

const REST = `${SUPABASE_URL}/rest/v1`;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** Sin timeout, un fetch colgado (tunel, red movil muerta a mitad de camino)
 * no resuelve ni rechaza: el catch de abajo nunca corre y la galeria queda
 * esperando el arbol de carpetas o las miniaturas para siempre. */
async function pedir<T>(url: string, init: RequestInit, etiqueta: string): Promise<T | null> {
  try {
    const timeoutSignal = AbortSignal.timeout(10_000);
    const signal = init.signal ? AbortSignal.any([init.signal as AbortSignal, timeoutSignal]) : timeoutSignal;
    const res = await fetch(url, { ...init, signal });
    if (!res.ok) {
      console.error(`Supabase ${etiqueta}: ${res.status} ${await res.text().catch(() => "")}`);
      return null;
    }
    if (res.status === 204) return null;
    const texto = await res.text();
    return texto ? (JSON.parse(texto) as T) : null;
  } catch (e) {
    console.error(`Supabase ${etiqueta}:`, e);
    return null;
  }
}

export interface ThumbnailRow {
  drive_file_id: string;
  file_name: string;
  thumbnail_base64: string;
  updated_at: string;
  /** modifiedAt de Drive al momento de generar esta miniatura. Null en filas
   * generadas antes de que se guardara este dato: se siguen sirviendo tal
   * cual. Cuando esta presente y no coincide con el modifiedAt actual del
   * archivo, la miniatura quedo vieja (el archivo se re-subio con otro
   * contenido) y hay que regenerarla en vez de servirla. */
  source_modified_at: string | null;
}

/** Cuantos ids entran en una sola consulta `in.(...)`. Cada id de Drive son
 * ~33 caracteres, y percent-encoded con comillas quedan en ~42; 50 ids dan
 * una URL de ~2100 caracteres, comodo por debajo de los limites tipicos de
 * URL (~8000). Sin este tope, una carpeta de 200 archivos armaba una URL de
 * ~8400 caracteres -> 414 URI Too Long, que `pedir()` traga como
 * `console.error` + `null`: el mapa volvia VACIO y los 200 archivos entraban
 * en cola para regenerar sus 200 miniaturas desde cero por rangos HTTP en
 * vez de servirse instantaneas desde el cache. */
const LOTE_THUMBNAILS = 50;

/** Trae del cache de Supabase las miniaturas ya generadas para estos ids. */
export async function fetchCachedThumbnails(
  ids: string[]
): Promise<Map<string, ThumbnailRow>> {
  const map = new Map<string, ThumbnailRow>();
  if (ids.length === 0) return map;

  for (let i = 0; i < ids.length; i += LOTE_THUMBNAILS) {
    const lote = ids.slice(i, i + LOTE_THUMBNAILS);
    // PostgREST: in.(a,b,c). Los ids de Drive son alfanumericos con - y _, sin
    // comas ni comillas, pero se citan igual por las dudas.
    const lista = lote.map((id) => `"${id}"`).join(",");
    const url =
      `${REST}/concept_thumbnails` +
      `?select=drive_file_id,file_name,thumbnail_base64,updated_at,source_modified_at` +
      `&drive_file_id=in.(${encodeURIComponent(lista)})`;

    const data = await pedir<ThumbnailRow[]>(url, { headers: headers() }, "leer thumbnails");
    (data || []).forEach((row) => map.set(row.drive_file_id, row));
  }
  return map;
}

/** Sube (o actualiza) la miniatura generada para un archivo. */
export async function upsertThumbnail(row: {
  drive_file_id: string;
  file_name: string;
  thumbnail_base64: string;
  source_size_bytes: number;
  /** modifiedAt de Drive del archivo del que se genero esta miniatura, para
   * poder detectar despues si el archivo cambio y la miniatura quedo vieja. */
  source_modified_at: string | null;
}): Promise<void> {
  await pedir(
    `${REST}/concept_thumbnails`,
    {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        drive_file_id: row.drive_file_id,
        file_name: row.file_name,
        thumbnail_base64: row.thumbnail_base64,
        source_size_bytes: row.source_size_bytes,
        source_modified_at: row.source_modified_at,
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
        updated_at: new Date().toISOString(),
      }),
    },
    "guardar thumbnail"
  );
}

export interface FolderCacheRow {
  folder_id: string;
  name: string;
  subfolders: DriveFolderRef[];
  files: DriveFile[];
  updated_at: string;
}

/** Pedido en vuelo, para deduplicar llamadas concurrentes (ver mas abajo). */
let fetchAllFolderCacheEnVuelo: Promise<Map<string, FolderCacheRow>> | null = null;

/**
 * Trae TODO el arbol de carpetas cacheado en un solo query (son solo ids y
 * nombres, liviano). Con esto la Gallery puede navegar entre carpetas ya
 * visitadas sin volver a pegarle a Drive.
 *
 * Deduplica llamadas CONCURRENTES: en un deep-link (`?file=<id>`), la
 * Gallery llama esto al montar Y `ubicarArchivo` (mas abajo) tambien lo
 * llama para resolver el nombre/ruta del archivo -- sin esto, el caso mas
 * comun de "alguien abre un link compartido" descargaba el arbol completo
 * DOS VECES en paralelo. No se cachea el RESULTADO (la Gallery ya tiene su
 * propio cache con su propia logica de invalidacion vía `folderTreeCacheRef`/
 * `folderTreeLoadedRef`); esto solo evita pedir lo mismo dos veces mientras
 * el primer pedido todavia esta en el aire.
 */
export async function fetchAllFolderCache(): Promise<Map<string, FolderCacheRow>> {
  if (fetchAllFolderCacheEnVuelo) return fetchAllFolderCacheEnVuelo;
  fetchAllFolderCacheEnVuelo = (async () => {
    const map = new Map<string, FolderCacheRow>();
    const data = await pedir<FolderCacheRow[]>(
      `${REST}/drive_folder_cache?select=*`,
      { headers: headers() },
      "leer cache de carpetas"
    );
    (data || []).forEach((row) => map.set(row.folder_id, row));
    return map;
  })();
  try {
    return await fetchAllFolderCacheEnVuelo;
  } finally {
    fetchAllFolderCacheEnVuelo = null;
  }
}

/** Guarda (o actualiza) el listado de una carpeta puntual en el cache. */
export async function upsertFolderCache(
  folderId: string,
  name: string,
  subfolders: DriveFolderRef[],
  files: DriveFile[]
): Promise<void> {
  await pedir(
    `${REST}/drive_folder_cache`,
    {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        folder_id: folderId,
        name,
        subfolders,
        files,
        updated_at: new Date().toISOString(),
      }),
    },
    "guardar cache de carpeta"
  );
}

/**
 * Busca un archivo por id en el arbol de carpetas cacheado y devuelve su
 * nombre y su ruta.
 *
 * Sirve para los links directos (`?file=<id>`): sin esto la app no sabe como
 * se llama el dibujo ni donde vive, y terminaba mostrando el id crudo como
 * nombre y una URL sin carpetas.
 */
export async function ubicarArchivo(
  fileId: string
): Promise<{ nombre: string; ruta: string[] } | null> {
  const arbol = await fetchAllFolderCache();
  if (arbol.size === 0) return null;

  // Padre de cada carpeta, para poder reconstruir la ruta hacia arriba.
  const padre = new Map<string, string>();
  arbol.forEach((fila) => {
    fila.subfolders.forEach((sub) => padre.set(sub.id, fila.folder_id));
  });

  for (const fila of arbol.values()) {
    const archivo = fila.files.find((f) => f.id === fileId);
    if (!archivo) continue;
    const ruta: string[] = [];
    let actual: string | undefined = fila.folder_id;
    // Se sube hasta la raiz (la raiz no tiene padre y no entra en la ruta).
    while (actual && padre.has(actual)) {
      ruta.unshift(arbol.get(actual)?.name || "");
      actual = padre.get(actual);
    }
    return { nombre: archivo.name.replace(/\.concepts$/i, "").trim(), ruta: ruta.filter(Boolean) };
  }
  return null;
}

/** Inserta un evento de uso (abrir/cerrar/descargar). */
export async function insertEvento(fila: Record<string, unknown>): Promise<void> {
  await pedir(
    `${REST}/visor_eventos`,
    {
      method: "POST",
      headers: headers({ Prefer: "return=minimal" }),
      body: JSON.stringify(fila),
    },
    "registrar metrica de uso"
  );
}
