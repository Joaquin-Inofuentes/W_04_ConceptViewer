/**
 * TTL del cache de listados de carpeta (`drive_folder_cache`) — C-15, hermano
 * de R3-01.
 *
 * Separado de `supabaseClient.ts` a proposito: ese archivo importa
 * `../config` sin extension, que Vite resuelve pero el `node --test` que usan
 * los tests de este repo (ver `src/lib/erroresDescarga.test.mjs`) no — Node
 * ejecuta TypeScript con sintaxis erasable pero sigue exigiendo resolucion de
 * modulos ESM estricta. Esta logica es pura (sin red, sin `navigator`, sin
 * config), asi que vive aparte y se puede testear con `node --test` sin
 * arrastrar nada.
 */

export interface FilaConFecha {
  updated_at: string;
}

/**
 * Cuanto tiempo se confia en el listado cacheado de una carpeta antes de
 * volver a pedirselo a Drive en vivo.
 *
 * Sin esto `drive_folder_cache` no vencia nunca: cuando Concepts re-sube un
 * `.concepts` con el mismo nombre, Drive le da un id NUEVO al archivo, pero
 * la fila cacheada seguia con el id viejo hasta que alguien apretaba
 * "Refrescar" a mano en esa carpeta puntual. Con el id viejo, abrir el
 * dibujo le pedia a `concepts-drive` (Edge Function) un fileId que ya no
 * existe en Drive, y esa funcion contesta 404/`drive-404` (ver
 * `resolverUrlDescarga` en `concepts-drive/index.ts`) — el 502 feo que
 * arreglo R3-01 era la consecuencia de esto mismo.
 *
 * 6 horas es un termino medio, no una medicion: bastante corto para que una
 * re-subida se note el mismo dia de trabajo sin tocar nada (el flujo tipico
 * es alguien dibujando en el iPad y volviendo a mirar el plano en la PC unas
 * horas despues), bastante largo para no pagar de nuevo el scrape de Drive
 * (`embeddedfolderview` + `_DRIVE_ivd`, dos requests HTML por carpeta) cada
 * vez que se entra a una carpeta ya visitada dentro de la misma sesion.
 */
export const TTL_CACHE_CARPETA_MS = 6 * 60 * 60 * 1000;

/** Si el listado cacheado de una carpeta ya paso el TTL y conviene volver a
 * preguntarle a Drive en vivo antes de confiar en los ids que trae. */
export function cacheDeCarpetaVencido(row: FilaConFecha): boolean {
  const actualizado = new Date(row.updated_at).getTime();
  if (!Number.isFinite(actualizado)) return true;
  return Date.now() - actualizado > TTL_CACHE_CARPETA_MS;
}
