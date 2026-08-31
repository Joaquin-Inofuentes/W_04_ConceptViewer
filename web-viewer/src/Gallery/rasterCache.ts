/**
 * Cache persistente (IndexedDB) de recursos ya rasterizados.
 *
 * Rasterizar un PDF con pdf.js cuesta ~1,5 s en desktop y ~9 s en un telefono
 * de gama baja, y ese costo se pagaba ENTERO cada vez que se abria el mismo
 * dibujo. Guardando el resultado como JPEG, reabrir cuesta un
 * createImageBitmap (~10-50 ms): dos ordenes de magnitud menos.
 *
 * Se guardan como mucho los ULTIMOS 3 archivos abiertos, y se desaloja por
 * cola (el que hace mas que no se usa sale primero). Guardar mas no ayuda: en
 * un telefono de 1 GB el espacio de IndexedDB es limitado y el usuario vuelve
 * casi siempre a los dibujos que acaba de ver.
 */

import { getBudgets } from "../device";

const DB_NAME = "concepts-raster";
/**
 * v3: los rasterizados de la v2 estan DEFORMADOS. Se guardaron usando el
 * viewport que pdf.js rota por /Rotate, cuando la geometria de Concepts vive
 * en el espacio sin rotar; subir la version borra el store y obliga a
 * regenerarlos bien. Sin esto, quien ya abrio un dibujo seguiria viendo los
 * planos aplastados aunque el codigo este arreglado.
 *
 * v4: los de la v3 estan CABEZA ABAJO. Se rasterizaban siempre con el viewport
 * sin rotar, y como estos planos traen /Rotate=90 y Concepts los coloca a -90,
 * el resultado quedaba a 180 grados (ver orientacion.ts). Mismo motivo para
 * subir la version: el arreglo no se nota si se sigue leyendo lo guardado.
 */
const DB_VERSION = 4;
const STORE = "bitmaps";
/** Cuantos ARCHIVOS distintos se conservan. */
export const MAX_ARCHIVOS_CACHEADOS = 3;

interface FilaCache {
  key: string;
  fileId: string;
  resourceId: string;
  /** Tamaño que se habia PEDIDO (no el guardado, que suele ser menor tras
   * recortar por resolucion nativa o presupuesto de RAM). */
  pedidoW: number;
  pedidoH: number;
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
  usadoEn: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function abrirDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // La v1 no tenia el indice por recurso; se recrea el store entero en vez
      // de migrar (es un cache, perderlo solo cuesta una rasterizacion).
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      const store = db.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("usadoEn", "usadoEn");
      store.createIndex("fileId", "fileId");
      store.createIndex("porRecurso", ["fileId", "resourceId"]);
    };
    req.onsuccess = () => resolve(req.result);
    // Modo incognito / storage bloqueado: se sigue sin cache, no es fatal.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function conStore<T>(
  modo: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return abrirDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, modo);
        } catch {
          return resolve(null);
        }
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      })
  );
}

/** Redondea a escalones de 1,25x para que un pedido de 812 px reuse el de 800
 * en vez de re-rasterizar 9 segundos por una diferencia invisible. */
function escalon(v: number): number {
  return Math.round(Math.pow(1.25, Math.round(Math.log(Math.max(v, 1)) / Math.log(1.25))));
}

/**
 * Version del formato guardado. Se sube cuando cambia COMO se rasteriza: las
 * entradas viejas siguen siendo bitmaps validos pero ya no representan lo que
 * hoy dibujariamos, y servirlas mostraria el bug recien arreglado. Paso con
 * las fotos con EXIF de rotacion, que se guardaban aplastadas 1,78x.
 *
 * v3: la CLAVE con la que se guardaba una foto vertical (EXIF 5-8) no
 * coincidia con la clave con la que se la buscaba (renderCore.ts guardaba
 * pedidoW/pedidoH ya intercambiados por la orientacion, y los buscaba sin
 * intercambiar, porque a la hora de consultar el cache todavia no se leyo
 * el archivo para saber la orientacion). El acierto de cache para esas fotos
 * era CERO: se re-rasterizaban enteras en cada apertura, y ademas dejaban
 * entradas basura en IndexedDB que nunca se leian y solo ocupaban lugar.
 * Subir la version las descarta.
 */
const VERSION_RASTER = 3;

export function claveRaster(fileId: string, resourceId: string, width: number, height: number): string {
  return `v${VERSION_RASTER}|${fileId}|${resourceId}|${escalon(width)}x${escalon(height)}`;
}

export interface PedidoCache {
  resourceId: string;
  pedidoW: number;
  pedidoH: number;
  cualquierTamaño?: boolean;
}

/**
 * Busca los rasterizados guardados de VARIOS recursos EN UNA SOLA transaccion
 * de IndexedDB.
 *
 * Antes cada recurso abria su propia transaccion (`db.transaction(...)`, con
 * hasta dos rondas si la clave exacta no estaba) desde `runPool(pendientes, 4,
 * ...)`, o sea hasta 4 transacciones simultaneas y N en total por
 * sincronizacion. Abrir una transaccion tiene costo fijo en el navegador aunque
 * la lectura en si sea trivial; con CPU profiling bajo 10x throttle eso
 * aparecia como self-time real (`transaction`, `req.onsuccess`) durante los
 * gestos, ~140ms sumados en una sola secuencia sobre el dibujo mas pesado.
 * Con una transaccion cubriendo TODOS los `get`/`getAll` del lote, el
 * navegador paga el costo de apertura una vez, no N veces.
 *
 * Dentro, dos niveles por recurso, igual que antes: primero la clave exacta,
 * y si no esta, CUALQUIER version guardada que sea al menos tan grande como
 * la pedida. Sin ese segundo nivel el cache fallaba cada vez que la clave se
 * corria un escalon —lo que pasa por ejemplo si el encuadre inicial cambia
 * unos pixeles, o si el presupuesto de RAM recorto el pedido— y el resultado
 * era volver a rasterizar el PDF entero teniendolo guardado. Medido: en un
 * dibujo de 6 recursos acertaba 4 y fallaba 2 por esto.
 */
export async function leerRasterVarios(
  fileId: string,
  pedidos: PedidoCache[]
): Promise<Map<string, ImageBitmap | null>> {
  const resultado = new Map<string, ImageBitmap | null>();
  if (pedidos.length === 0) return resultado;

  const db = await abrirDb();
  if (!db) {
    pedidos.forEach((p) => resultado.set(p.resourceId, null));
    return resultado;
  }

  let tx: IDBTransaction;
  try {
    tx = db.transaction(STORE, "readonly");
  } catch {
    pedidos.forEach((p) => resultado.set(p.resourceId, null));
    return resultado;
  }
  const store = tx.objectStore(STORE);
  const indice = store.index("porRecurso");

  const filas = new Map<string, FilaCache | null>();
  const promesas = pedidos.map(
    (p) =>
      new Promise<void>((resolve) => {
        const reqExacta = store.get(claveRaster(fileId, p.resourceId, p.pedidoW, p.pedidoH)) as IDBRequest<FilaCache>;
        reqExacta.onerror = () => { filas.set(p.resourceId, null); resolve(); };
        reqExacta.onsuccess = () => {
          if (reqExacta.result) { filas.set(p.resourceId, reqExacta.result); resolve(); return; }
          const reqIdx = indice.getAll([fileId, p.resourceId]) as IDBRequest<FilaCache[]>;
          reqIdx.onerror = () => { filas.set(p.resourceId, null); resolve(); };
          reqIdx.onsuccess = () => {
            const candidatas = reqIdx.result || [];
            // Sirve la que se pidio con al menos el 80% del tamaño actual
            // (por debajo de eso se veria borrosa al acercarse). De las que
            // sirven, la mas chica, para no gastar RAM de mas.
            const utiles = candidatas
              .filter((c) => c.pedidoW >= p.pedidoW * 0.8 && c.pedidoH >= p.pedidoH * 0.8)
              .sort((a, b) => a.pedidoW * a.pedidoH - b.pedidoW * b.pedidoH);
            let fila = utiles[0] || null;
            // Como ADELANTO (mostrar algo mientras se rasteriza lo bueno)
            // sirve cualquier cosa que haya, aunque sea mas chica de lo
            // pedido: se va a ver borrosa unos segundos, que es infinitamente
            // mejor que el hueco gris. Se elige la mas grande disponible.
            if (!fila && p.cualquierTamaño) {
              fila = [...candidatas].sort((a, b) => b.pedidoW * b.pedidoH - a.pedidoW * a.pedidoH)[0] || null;
            }
            filas.set(p.resourceId, fila);
            resolve();
          };
        };
      })
  );
  await Promise.all(promesas);

  // Decodificar los bitmaps FUERA de la transaccion: createImageBitmap es
  // async y una transaccion de IDB se auto-cierra en cuanto no le quedan
  // pedidos pendientes, asi que hacerlo adentro no alarga nada, solo
  // complicaria el manejo de errores.
  //
  // Por LOTES de `concurrency`, no todos a la vez: al reabrir un dibujo de
  // 19 planos, decodificar 19 JPEGs de 1-3 Mpx en paralelo es un pico de
  // jank grande justo en el momento de abrir -- el peor momento posible,
  // porque es cuando el usuario esta mirando la pantalla esperando. Ir de a
  // `concurrency` reparte ese trabajo en el tiempo sin cambiar el resultado
  // final (el orden de llegada no importa, todos terminan antes de que
  // `leerRasterVarios` resuelva).
  const concurrency = Math.max(1, getBudgets().concurrency);
  for (let i = 0; i < pedidos.length; i += concurrency) {
    const lote = pedidos.slice(i, i + concurrency);
    await Promise.all(
      lote.map(async (p) => {
        const fila = filas.get(p.resourceId);
        if (!fila || !fila.blob) { resultado.set(p.resourceId, null); return; }
        try {
          const bitmap = await createImageBitmap(fila.blob);
          resultado.set(p.resourceId, bitmap);
          // Renovar "usado en", fire-and-forget: no bloquea la respuesta y no
          // hace falta que comparta transaccion con la lectura.
          void conStore("readwrite", (s) => s.put({ ...fila, usadoEn: Date.now() }));
        } catch {
          resultado.set(p.resourceId, null);
        }
      })
    );
  }

  return resultado;
}

/** Busca el rasterizado guardado de UN recurso. Atajo sobre
 * `leerRasterVarios` para el caso de a uno; si vas a pedir varios, usar
 * esa directamente ahorra abrir una transaccion de IndexedDB por recurso. */
export async function leerRaster(
  fileId: string,
  resourceId: string,
  pedidoW: number,
  pedidoH: number,
  opciones: { cualquierTamaño?: boolean } = {}
): Promise<ImageBitmap | null> {
  const mapa = await leerRasterVarios(fileId, [{ resourceId, pedidoW, pedidoH, cualquierTamaño: opciones.cualquierTamaño }]);
  return mapa.get(resourceId) ?? null;
}

/** Escribe una fila ya armada (blob ya codificado) y programa la poda. Es el
 * unico punto que de verdad toca IndexedDB desde estas dos funciones. */
async function escribirFila(fila: FilaCache): Promise<void> {
  await conStore("readwrite", (s) => s.put(fila));
  programarPoda();
}

/**
 * Guarda un rasterizado YA codificado como JPEG.
 *
 * Es el camino barato: el llamador (el worker de rasterizado, ver la nota
 * larga en `raster.worker.ts` sobre `PedidoRaster.cachear`) ya hizo el
 * drawImage y la codificacion, los dos fuera de este hilo. Aca no queda otra
 * cosa que escribir bytes a IndexedDB.
 */
export async function guardarRasterBlob(
  fileId: string,
  resourceId: string,
  pedidoW: number,
  pedidoH: number,
  blob: Blob,
  width: number,
  height: number
): Promise<void> {
  if (!(width > 0) || !(height > 0)) return;
  try {
    await escribirFila({
      key: claveRaster(fileId, resourceId, pedidoW, pedidoH),
      fileId,
      resourceId,
      pedidoW: Math.round(pedidoW),
      pedidoH: Math.round(pedidoH),
      blob,
      width,
      height,
      bytes: blob.size,
      usadoEn: Date.now(),
    });
  } catch {
    /* sin cache */
  }
}

/**
 * Guarda un rasterizado codificandolo ACA MISMO: drawImage a un canvas nuevo
 * mas `convertToBlob`/`toBlob`.
 *
 * Es el camino caro, y por eso solo deberia usarse cuando no hay opcion
 * mejor: el rasterizado en el hilo principal (sin OffscreenCanvas o con el
 * pool de workers caido — ver `enMain` en `renderCore.ts`). Cuando el worker
 * rasterizo, usar `guardarRasterBlob` en su lugar: el worker ya tiene el
 * bitmap pintado y codificarlo ahi no compite con los gestos del usuario por
 * el hilo principal (medido con CPU profiling: este drawImage+encode era el
 * offender individual mas grande del hilo principal durante apertura+zoom,
 * 2,8 s de self-time en el dibujo mas pesado del corpus).
 *
 * Silencioso ante errores: el cache es un lujo, no puede romper la apertura
 * de un dibujo.
 */
export async function guardarRaster(
  fileId: string,
  resourceId: string,
  pedidoW: number,
  pedidoH: number,
  fuente: CanvasImageSource
): Promise<void> {
  try {
    const width = (fuente as any).width as number;
    const height = (fuente as any).height as number;
    if (!(width > 0) || !(height > 0)) return;

    // Acepta tanto ImageBitmap (camino del worker) como HTMLCanvasElement
    // (fallback en el hilo principal). Guardar solo los ImageBitmap dejaba el
    // cache vacio en cuanto el worker no arrancaba, y como el fallback es
    // silencioso eso no se notaba.
    let blob: Blob | null = null;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(fuente, 0, 0);
      // JPEG: un plano rasterizado de 1500x800 pesa ~150 KB en JPEG contra
      // ~5 MB en PNG, y la diferencia visual a esta escala es nula.
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
      canvas.width = 0;
      canvas.height = 0;
    } else if (typeof HTMLCanvasElement !== "undefined" && fuente instanceof HTMLCanvasElement) {
      blob = await new Promise<Blob | null>((r) => fuente.toBlob(r, "image/jpeg", 0.88));
    }
    if (!blob) return;

    await escribirFila({
      key: claveRaster(fileId, resourceId, pedidoW, pedidoH),
      fileId,
      resourceId,
      pedidoW: Math.round(pedidoW),
      pedidoH: Math.round(pedidoH),
      blob,
      width,
      height,
      bytes: blob.size,
      usadoEn: Date.now(),
    });
  } catch {
    /* sin cache */
  }
}

let podaProgramada: ReturnType<typeof setTimeout> | null = null;

/**
 * Poda con espera, en vez de tras CADA guardado.
 *
 * `podar()` hace un getAll() del store entero. Llamarlo despues de cada
 * recurso significaba, al abrir un dibujo con 19 planos, 19 lecturas completas
 * del cache (hasta 50 MB) desde el hilo principal — justo mientras el usuario
 * esta paneando. Con la espera se hace una sola vez al final de la tanda.
 */
function programarPoda() {
  if (podaProgramada) clearTimeout(podaProgramada);
  podaProgramada = setTimeout(() => {
    podaProgramada = null;
    const correr = () => void podar();
    // En un rato libre, para no competir con el dibujado.
    if (typeof requestIdleCallback === "function") requestIdleCallback(correr, { timeout: 5000 });
    else correr();
  }, 4000);
}

let podando = false;

/**
 * Desaloja por cola: primero los ARCHIVOS que hace mas que no se abren (se
 * conservan los ultimos MAX_ARCHIVOS_CACHEADOS), y despues, si aun no entra
 * en el presupuesto del dispositivo, las entradas mas viejas.
 */
async function podar(): Promise<void> {
  if (podando) return;
  podando = true;
  try {
    const filas = (await conStore<FilaCache[]>("readonly", (s) => s.getAll() as IDBRequest<FilaCache[]>)) as
      | FilaCache[]
      | null;
    if (!filas || filas.length === 0) return;

    // Ultimo uso por archivo, para saber cuales son los 3 mas recientes.
    const ultimoPorArchivo = new Map<string, number>();
    filas.forEach((f) => {
      ultimoPorArchivo.set(f.fileId, Math.max(ultimoPorArchivo.get(f.fileId) || 0, f.usadoEn || 0));
    });
    const archivosOrdenados = [...ultimoPorArchivo.entries()].sort((a, b) => b[1] - a[1]);
    const aConservar = new Set(archivosOrdenados.slice(0, MAX_ARCHIVOS_CACHEADOS).map(([id]) => id));

    let quedan: FilaCache[] = [];
    for (const f of filas) {
      if (aConservar.has(f.fileId)) quedan.push(f);
      else await conStore("readwrite", (s) => s.delete(f.key));
    }

    // Segundo corte: el presupuesto de bytes del dispositivo.
    const tope = getBudgets().maxRasterCacheBytes;
    let total = quedan.reduce((n, f) => n + (f.bytes || 0), 0);
    if (total <= tope) return;
    quedan.sort((a, b) => (a.usadoEn || 0) - (b.usadoEn || 0));
    for (const f of quedan) {
      if (total <= tope) break;
      await conStore("readwrite", (s) => s.delete(f.key));
      total -= f.bytes || 0;
    }
  } finally {
    podando = false;
  }
}

/** Borra todo lo cacheado de un archivo (ej. cambio en Drive). */
export async function invalidarArchivo(fileId: string): Promise<void> {
  // Antes: un `getAll()` mas UNA TRANSACCION POR FILA para borrar (`await`
  // dentro del `for`). Con un archivo con muchas entradas cacheadas (varias
  // resoluciones por recurso) eran decenas de transacciones secuenciales, y
  // mientras tanto el visor ya podia haber empezado a leer del cache viejo
  // (ver `handleOpen` en Gallery.tsx, que ahora espera esta funcion antes de
  // abrir). Un cursor sobre el indice borra todo en UNA sola transaccion.
  const db = await abrirDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
    const cursorReq = tx.objectStore(STORE).index("fileId").openCursor(IDBKeyRange.only(fileId));
    cursorReq.onerror = () => resolve();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return; // la transaccion se completa sola
      cursor.delete();
      cursor.continue();
    };
  });
}

const MTIMES_KEY = "concepts-raster-mtimes";

function leerMtimesConocidos(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(MTIMES_KEY) || "{}");
  } catch {
    return {};
  }
}

/** Techo de entradas antes de podar las mas viejas. Una entrada pesa ~60
 * bytes (un fileId de Drive + un timestamp ISO); 2000 son ~120 KB, lejos de
 * cualquier cuota real de localStorage (5-10 MB tipico). */
const MAX_MTIMES = 2000;

function guardarMtimesConocidos(m: Record<string, string>) {
  try {
    let aGuardar = m;
    // Sin esto el objeto crece para siempre: se agrega una entrada por
    // dibujo abierto y nunca se borra ninguna. Para un uso real (una
    // inmobiliaria con miles de planos a lo largo de meses) eso es un
    // Record cada vez mas pesado de parsear/serializar en CADA apertura, sin
    // ningun beneficio -- lo unico que importa es el modifiedAt RECIENTE de
    // cada archivo. Las claves de un objeto JS con ids de Drive (alfanumericos
    // con guiones, no numericos) preservan el orden de insercion, asi que
    // Object.keys(m) ya trae "mas viejo primero" sin ordenar nada.
    const claves = Object.keys(m);
    if (claves.length > MAX_MTIMES) {
      aGuardar = {};
      // Se descarta la mitad de entradas vistas hace MAS tiempo (no la mitad
      // "menos usada": reasignar una clave existente no la mueve de lugar, asi
      // que esto es FIFO por primera vez vista, no LRU). Podar de a una por
      // vez en cada llamada volveria a disparar el corte en la apertura
      // siguiente; podar a la mitad da margen para varios miles de aperturas
      // antes de que haga falta podar de nuevo.
      for (const k of claves.slice(-Math.floor(MAX_MTIMES / 2))) aGuardar[k] = m[k];
    }
    localStorage.setItem(MTIMES_KEY, JSON.stringify(aGuardar));
  } catch {
    /* localStorage lleno o bloqueado: no es fatal, solo se pierde la deteccion */
  }
}

/**
 * Si el `modifiedAt` de Drive de este archivo cambio respecto a la ultima
 * vez que se abrio en este dispositivo, borra sus rasterizados cacheados:
 * de lo contrario `leerRaster` seguiria sirviendo bitmaps del contenido
 * VIEJO (esta cacheado por fileId+resourceId, sin relacion con el contenido
 * real) aunque el archivo se haya re-subido con dibujos distintos.
 *
 * Guarda el ultimo `modifiedAt` visto en localStorage (no en el cache de
 * IndexedDB, que se borra) para poder comparar la proxima vez.
 */
export async function invalidarSiCambio(fileId: string, modifiedAt: string | null): Promise<void> {
  if (!modifiedAt) return;
  const mtimes = leerMtimesConocidos();
  if (mtimes[fileId] && mtimes[fileId] !== modifiedAt) {
    await invalidarArchivo(fileId);
  }
  mtimes[fileId] = modifiedAt;
  guardarMtimesConocidos(mtimes);
}

/** Cuantos archivos y bytes hay cacheados (para diagnostico y para la UI). */
export async function estadoCache(): Promise<{ archivos: number; entradas: number; bytes: number }> {
  const filas = (await conStore<FilaCache[]>("readonly", (s) => s.getAll() as IDBRequest<FilaCache[]>)) as
    | FilaCache[]
    | null;
  if (!filas) return { archivos: 0, entradas: 0, bytes: 0 };
  return {
    archivos: new Set(filas.map((f) => f.fileId)).size,
    entradas: filas.length,
    bytes: filas.reduce((n, f) => n + (f.bytes || 0), 0),
  };
}

/** Vacia el cache de rasterizados. Lo usa el boton de restablecer. */
export async function vaciarCache(): Promise<void> {
  await conStore("readwrite", (s) => s.clear());
}
