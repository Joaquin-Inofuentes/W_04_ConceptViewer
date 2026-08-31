import { decode, ExtensionCodec } from "@msgpack/msgpack";
import { ZipArchive, BufferSource, FileSource, RemoteSource } from "./zip";
import type { ZipSource } from "./zip";
import { getBudgets } from "../device";

export interface BBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Point {
  x: number;
  y: number;
  p: number; // pressure
  t1: number; // tilt1
  t2: number; // tilt2
}

export interface Stroke {
  id: string;
  points: Point[];
  color: { r: number; g: number; b: number; a: number; hex: string };
  width: number;
  bbox: BBox;
}

export interface ImageElement {
  id: string;
  resourceId: string;
  blobUrl?: string;
  width: number;
  height: number;
  transform: number[];
  /**
   * true para fotos (item tipo 7, JPG), false/undefined para paginas de PDF
   * (item tipo 8).
   *
   * El dibujado NO lo mira: la orientacion de una foto sale de su EXIF, que se
   * lee del propio recurso. Queda porque distinguir "foto" de "plano" es util
   * para la galeria y los bancos de pruebas.
   */
  isPhoto?: boolean;
}

/**
 * Texto escrito con la herramienta de texto (item tipo 13), a diferencia de una
 * anotacion a mano alzada (que es un trazo comun).
 *
 * El cuerpo del item es `[1, <cabecera>, "el texto", <matriz extra>]`. La
 * posicion sale de la matriz de la CABECERA, igual que en las imagenes; la
 * matriz extra se descarta a proposito: se repite identica entre textos que
 * estan en lugares distintos del mismo dibujo (medido: cuatro "Corregir en
 * obra" separados por miles de unidades comparten `tr=[-1359,569]`), asi que no
 * es una colocacion.
 */
export interface TextElement {
  id: string;
  /** Puede tener saltos de linea. */
  text: string;
  color: { r: number; g: number; b: number; a: number; hex: string };
  transform: number[];
}

export interface Layer {
  id: string;
  index: number;
  strokes: Stroke[];
  images: ImageElement[];
  texts: TextElement[];
}

/**
 * Encuadre guardado por la app dentro de `workspace.pack`.
 *
 * El nodo trae `[1, ext1(ancho,alto de viewport), ext2(zoom min,max),
 * ext0(pan x,y), zoom, rotacion]`. La rotacion viene en VUELTAS (el motor la
 * llama `RotationTurn`), no en grados ni radianes.
 */
export interface Camara {
  viewport: { w: number; h: number };
  pan: { x: number; y: number };
  zoom: number;
  /** Rotacion de la vista, en vueltas (0..1). Casi siempre ~0. */
  rotacionVueltas: number;
}

export interface Document {
  layers: Layer[];
  bbox: BBox;
  /**
   * Ids de los recursos efectivamente COLOCADOS en alguna capa, del mas
   * chico al mas grande (asi lo que se puede mostrar antes se muestra
   * antes). Un .concepts guarda todos los adjuntos que se usaron alguna vez
   * — el dibujo de 262 MB trae 96 PDFs y solo 19 estan en el lienzo — asi
   * que esta lista es MUCHO mas corta que el contenido del zip.
   */
  resourceIds: string[];
  /** Tamaño comprimido de cada recurso, para poder priorizar y estimar. */
  resourceSizes: Record<string, number>;
  /**
   * Materializa un recurso a demanda. En un archivo remoto esto dispara un
   * rango HTTP; en uno local, una lectura del buffer. Devuelve null si el
   * recurso no esta en el zip (referencia rota).
   */
  loadResource(id: string): Promise<Blob | null>;
  /**
   * Trae por adelantado los bytes de varios recursos en pocas requests (los
   * recursos estan contiguos en el archivo). Sin esto se gasta una ida y
   * vuelta HTTP por recurso: 19 planos = 19 viajes de ~1,1 s cada uno.
   * Es una optimizacion: si falla, `loadResource` igual funciona.
   */
  prefetchResources(ids: string[]): Promise<void>;
  /** Suelta el archivo/las conexiones. Idempotente. */
  close(): void;
  /** Total de bytes del archivo (para diagnostico y metricas). */
  totalBytes: number;
  /**
   * Encuadre con el que la app dejo guardado el dibujo (`workspace.pack`), si
   * el archivo lo trae. Sirve para abrirlo mirando la misma parte que mostraba
   * Concepts en vez de encuadrar todo el contenido.
   */
  camara: Camara | null;
  /**
   * Bytes que hay que transferir de verdad para mostrar el dibujo completo:
   * el arbol del documento mas los recursos efectivamente colocados. Es la
   * base del porcentaje de carga — sin esto habria que inventar un numero,
   * porque el tamaño del archivo (262 MB) no tiene relacion con lo que se
   * baja (11 MB).
   */
  bytesNecesarios: number;
}

const extensionCodec = new ExtensionCodec();
const dummyEncode = () => new Uint8Array();

extensionCodec.register({
  type: 0,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getFloat32(0, true), view.getFloat32(4, true)];
  },
});
extensionCodec.register({
  type: 1,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getFloat32(0, true), view.getFloat32(4, true)];
  },
});
extensionCodec.register({
  type: 2,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getFloat32(0, true), view.getFloat32(4, true)];
  },
});
extensionCodec.register({
  type: 4,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [
      view.getFloat32(0, true),
      view.getFloat32(4, true),
      view.getFloat32(8, true),
      view.getFloat32(12, true),
    ];
  },
});
extensionCodec.register({
  type: 5,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const hex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
});
extensionCodec.register({
  type: 7,
  encode: dummyEncode,
  decode: (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const m = [];
    for (let i = 0; i < 16; i++) {
      m.push(view.getFloat32(i * 4, true));
    }
    return m;
  },
});

/**
 * Concepts guarda el documento con Y hacia ARRIBA (convencion matematica); el
 * canvas del navegador tiene Y hacia abajo. La conversion correcta es invertir
 * SOLO Y.
 *
 * Antes aca se negaban las dos coordenadas, que es una ROTACION DE 180 grados.
 * La diferencia entre rotar 180 e invertir Y es un espejado horizontal, y por
 * eso todo el dibujo salia en espejo: se veia "derecho" de lejos (por eso paso
 * desapercibido y quedo escrito que el documento venia girado media vuelta),
 * pero cada glifo estaba dado vuelta. Se comprobo renderizando la misma region
 * del mismo archivo con las dos convenciones: con inversion de Y se lee
 * "7,60x12,60x0,50 = 4,66 m3", con la rotacion de 180 se lee al reves.
 *
 * El sintoma que lo delataba en `Fede y Franco/Concepts/HO/Drawing`: las
 * anotaciones "+0,10" y "+0,40" se leian ESPEJADAS mientras el rotulo del plano
 * de al lado ("Holmberg 1764") se leia perfecto — porque las imagenes, al
 * dibujarse como bitmap, recibian ademas el volteo vertical propio del mapa de
 * pixeles y eso les cancelaba media vuelta. Ahora la convencion es una sola y
 * el volteo del bitmap se hace explicito al dibujar (ver `dibujarRecurso`).
 */
function aCanvasPunto(x: number, y: number): [number, number] {
  return [x, -y];
}

/**
 * La misma inversion de Y, compuesta con la matriz que coloca un recurso.
 *
 * Es `F . M` con `F = diag(1,-1)`: el recurso primero se coloca donde dice su
 * matriz (en coordenadas del documento, Y arriba) y recien despues se pasa a
 * coordenadas de canvas. NO alcanza con negar las 6 componentes — eso es rotar
 * 180 grados, que es justamente el error que se corrigio.
 */
function aCanvasTransform(m: number[]): number[] {
  if (!m || m.length !== 16) return m;
  // OJO con los indices: en la matriz 4x4 la afin 2D vive en
  // [0]=a [1]=b [4]=c [5]=d [12]=e [13]=f. Componer con diag(1,-1) por
  // izquierda niega la FILA de las Y, o sea b, d y f (1, 5 y 13).
  const s = m.slice();
  s[1] = -s[1];   // b
  s[5] = -s[5];   // d
  s[13] = -s[13]; // f
  return s;
}

/*
 * NO existe (ya no) un `espejarX` para las matrices de colocacion.
 *
 * Durante mucho tiempo las imagenes y los textos se convertian a canvas con un
 * espejo en X ADEMAS de la inversion de Y. Espejar en X y despues invertir Y es
 * negar las 6 componentes de la afin, o sea una ROTACION DE 180 grados: la
 * misma convencion equivocada que ya se habia corregido para los trazos. El
 * resultado era que todo elemento DESCENTRADO se dibujaba del lado opuesto del
 * dibujo, mientras los trazos (que si usaban la convencion correcta) se
 * quedaban donde iban.
 *
 * Por que tardo tanto en verse: el error es un espejo respecto del origen, asi
 * que un elemento centrado casi no se mueve. En `MARIANO ACHA 2363/5to Piso`
 * las tres tiras de plano estan a x = -12, -8 y -3 unidades (se corrian un 1%,
 * invisible) pero las cuatro laminas de caldera estan a x = +-254 y +-405: esas
 * salian INTERCAMBIADAS izquierda-derecha. Comprobado contra la app en tablet y
 * contra el thumb.jpg del propio archivo: la app pone la caldera 4A arriba a la
 * izquierda y 4C arriba a la derecha; con el espejo salian al reves.
 *
 * Y por que el espejo "parecia" funcionar: lo que de verdad arreglaba era la
 * ORIENTACION DEL CONTENIDO, que se corrige en `dibujarRecurso` volteando el
 * bitmap en vertical dentro de su caja (el documento es Y-arriba, un mapa de
 * pixeles no). Para un recurso rotado 90 grados las dos cosas dan exactamente
 * lo mismo — `flipY . R(90) . flipY == rot180 . R(90)` — y TODOS los PDF de
 * plano entran rotados 90, asi que el rotulo se leia bien igual. La diferencia
 * aparece justo en los recursos sin rotar o rotados 180, que son casi siempre
 * las fotos: esas salian cabeza abajo.
 */

/**
 * Aplica la afin guardada en una matriz 4x4 a un punto 2D.
 * Solo se usan las 6 componentes de la afin (0,1,4,5,12,13).
 */
function aplicarMatriz(m: number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]];
}

/** Factor de escala de una afin, para poder escalar el ancho de un trazo. */
function escalaDe(m: number[]): number {
  const det = m[0] * m[5] - m[1] * m[4];
  const s = Math.sqrt(Math.abs(det));
  return Number.isFinite(s) && s > 1e-6 ? s : 1;
}

/** ¿La parte afin de la matriz es la identidad? (el caso abrumadoramente
 * mayoritario: un trazo que nadie movio desde que se dibujo). */
function esIdentidad(m: number[]): boolean {
  return (
    Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 &&
    Math.abs(m[4]) < 1e-6 && Math.abs(m[5] - 1) < 1e-6 &&
    Math.abs(m[12]) < 1e-6 && Math.abs(m[13]) < 1e-6
  );
}

/**
 * Matriz de colocacion de un elemento, si la cabecera la trae.
 *
 * Trazos e imagenes comparten EXACTAMENTE la misma cabecera:
 *
 *   [3, <estilo>, UUID, null, null, 0, <timestamp>, MATRIZ, false, <int>]
 *                                                   ^ indice 7
 *
 * Durante mucho tiempo se leyo solo para las imagenes. Concepts NO reescribe
 * los puntos cuando moves, rotas o escalas trazos: actualiza esta matriz. Al
 * ignorarla, los trazos que el usuario habia movido se dibujaban en su posicion
 * ORIGINAL — medido sobre el corpus, el 30,6% de los trazos (9.813 de 32.085)
 * tiene matriz distinta de identidad, y hay archivos donde son el 73%. Ese es
 * el bug de "las anotaciones vuelan lejos del plano".
 */
function matrizDeCabecera(cabecera: unknown): number[] | null {
  if (!Array.isArray(cabecera) || cabecera[0] !== 3) return null;
  const m = cabecera[7];
  return Array.isArray(m) && m.length === 16 ? (m as number[]) : null;
}

function rgbaToHex(r: number, g: number, b: number, a: number) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const hexR = Math.round(clamp(r) * 255).toString(16).padStart(2, "0");
  const hexG = Math.round(clamp(g) * 255).toString(16).padStart(2, "0");
  const hexB = Math.round(clamp(b) * 255).toString(16).padStart(2, "0");
  const hexA = Math.round(clamp(a) * 255).toString(16).padStart(2, "0");
  return `#${hexR}${hexG}${hexB}${hexA}`;
}

/**
 * Devuelve la vista previa que la propia app Concepts deja adentro del
 * archivo (`thumb.jpg`), si esta. Es una imagen de 640x1024 renderizada por
 * Concepts: se ve mejor que cualquier cosa que podamos dibujar nosotros y
 * sale por dos ordenes de magnitud menos de trabajo — no hay que decodificar
 * el arbol del documento ni rasterizar los PDFs embebidos (que cuestan ~1,5 s
 * cada uno sin importar a que tamaño se los pida).
 */
export async function readEmbeddedThumbnail(
  fuente: ArrayBuffer | ZipSource
): Promise<Blob | null> {
  const intentar = async (): Promise<Blob | null> => {
    const zip = await ZipArchive.open(fuente as ZipSource);
    const nombre = zip.names().find((n) => /(^|\/)thumb\.jpe?g$/i.test(n));
    // Esto SI es "no hay vista previa": no hay entrada `thumb.jpg` en el
    // zip, nada que reintentar. Ver el mismo criterio en `ConceptsFile.
    // thumbnail()` de `openConceptsSource`, mas abajo.
    if (!nombre) return null;
    return await zip.readBlob(nombre, "image/jpeg");
  };
  try {
    return await intentar();
  } catch {
    // Pero un fallo de LECTURA (502 esporadico del proxy, indice corrupto de
    // un rango cortado a mitad de camino) es otra cosa: antes se trataba
    // igual que "no trae vista previa" y esta funcion la usa el crawler de
    // reindexado masivo (`driveCrawler.ts`), que interpreta null como
    // "sin miniatura para este archivo" y sigue de largo -- un 502
    // transitorio dejaba un archivo marcado como sin vista previa PARA
    // SIEMPRE en el cache de Supabase, con reintentar como unico arreglo
    // manual. Un solo reintento corto cubre el caso comun.
    await new Promise((r) => setTimeout(r, 400));
    try {
      return await intentar();
    } catch {
      return null;
    }
  }
}

/** Miniatura embebida leyendo por rangos: en vez de bajar el archivo entero
 * (262 MB) para sacar una imagen de 192 px, baja el indice + el thumb.jpg
 * (~110 KB en el peor caso, 2400x menos datos). */
export async function readEmbeddedThumbnailRemote(
  url: string,
  headers: Record<string, string> = {}
): Promise<Blob | null> {
  try {
    const source = await RemoteSource.open(url, headers);
    return await readEmbeddedThumbnail(source);
  } catch {
    return null;
  }
}

export interface ParseOptions {
  /** Se llama con los bytes transferidos, para medir el ahorro real. */
  onBytes?: (n: number) => void;
  signal?: AbortSignal;
}

/**
 * FASE 1 del parseo: decodifica el arbol del documento (trazos, capas y la
 * ubicacion de las imagenes) leyendo SOLO `tree.pack`. Los recursos pesados
 * (fotos, PDFs) no se tocan: quedan disponibles via `doc.loadResource(id)`.
 *
 * Medido sobre la carpeta real: `tree.pack` pesa 0,79 MB en el dibujo de
 * 262,9 MB y vive en el offset 0 del zip, asi que los trazos se pueden
 * mostrar bajando ~1 MB en vez de 262.
 */
export async function parseConceptsSource(
  fuente: ZipSource,
  opts: ParseOptions = {}
): Promise<Document> {
  void opts;
  return documentoDesdeZip(await ZipArchive.open(fuente), fuente);
}

/**
 * Lee el encuadre guardado de `workspace.pack`.
 *
 * `workspace.pack` es el estado de la interfaz con el que se cerro el dibujo:
 * posicion de los paneles, paleta, herramienta activa... y al final, la camara.
 * Se busca el nodo por FORMA en vez de por indice fijo (`[1, par, par, par,
 * numero, numero]`, con un viewport de tamaño plausible) porque el resto del
 * archivo son estructuras de UI que pueden cambiar entre versiones de la app y
 * correrian las posiciones.
 *
 * Nunca es un error que falte: si no aparece, el visor encuadra el contenido
 * como venia haciendo.
 */
async function leerCamara(zip: ZipArchive): Promise<Camara | null> {
  try {
    const nombre = zip.names().find((n) => /(^|\/)workspace\.pack$/.test(n));
    if (!nombre) return null;
    const ws = decode(await zip.read(nombre), { extensionCodec }) as any;
    if (!Array.isArray(ws)) return null;

    let hallada: Camara | null = null;
    const esPar = (v: any) => Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number";
    const buscar = (o: any) => {
      if (hallada || !Array.isArray(o)) return;
      if (
        o.length === 6 && o[0] === 1 &&
        esPar(o[1]) && esPar(o[2]) && esPar(o[3]) &&
        typeof o[4] === "number" && typeof o[5] === "number" &&
        o[1][0] > 100 && o[1][1] > 100 && o[4] > 0
      ) {
        hallada = {
          viewport: { w: o[1][0], h: o[1][1] },
          pan: { x: o[3][0], y: o[3][1] },
          zoom: o[4],
          rotacionVueltas: o[5],
        };
        return;
      }
      for (const x of o) buscar(x);
    };
    buscar(ws);
    return hallada;
  } catch {
    return null;
  }
}

async function documentoDesdeZip(zip: ZipArchive, fuente: ZipSource): Promise<Document> {
  const nombreTree = zip.has("tree.pack")
    ? "tree.pack"
    : zip.names().find((n) => /(^|\/)tree\.pack$/.test(n));
  if (!nombreTree) {
    throw new Error("No se encontró tree.pack en el archivo.");
  }
  // `leerCamara` lee workspace.pack, un rango totalmente independiente de
  // tree.pack: antes se esperaba DESPUES de terminar todo el procesamiento
  // de capas/trazos, sumando en serie una request de rango extra + un
  // decode entero + una busqueda recursiva (ver su comentario: "nunca es un
  // error que falte", es puramente cosmetica) al camino critico, antes de
  // que el visor pudiera dibujar un solo trazo. Pedirlas en paralelo con
  // Promise.all no cambia el contrato (`doc.camara` sigue disponible de
  // forma sincronica cuando `doc` se devuelve) pero le saca ese tiempo
  // muerto: las dos requests salen a la red a la vez en vez de una tras otra.
  const [treeData, camara] = await Promise.all([zip.read(nombreTree), leerCamara(zip)]);
  const tree = decode(treeData, { extensionCodec }) as any;

  const docData = Array.isArray(tree) && tree.length > 1 ? tree[1] : tree;

  const layers: Layer[] = [];
  const globalBbox: BBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };

  if (Array.isArray(docData)) {
    const docCapas = docData.find(x => Array.isArray(x) && x.length > 0 && x.every(c => Array.isArray(c) && c.length > 0 && c[0] === 1));

    if (docCapas) {
      docCapas.forEach((capa: any, index: number) => {
        layers.push(procesarCapa(capa, index, globalBbox));
      });
    } else {
      const fallbackLayer: Layer = { id: "fallback", index: 0, strokes: [], images: [], texts: [] };
      buscarElementos(docData, fallbackLayer, globalBbox);
      if (fallbackLayer.strokes.length > 0 || fallbackLayer.images.length > 0 || fallbackLayer.texts.length > 0) {
        layers.push(fallbackLayer);
      }
    }
  }

  const { ids, sizes, porId } = mapearRecursos(zip, layers);

  /**
   * Bytes ya bajados de cada recurso, con tope.
   *
   * Antes era un Map sin limite que solo se vaciaba al cerrar el dibujo: con
   * 96 imagenes colocadas, recorrer el dibujo entero terminaba reteniendo los
   * 262 MB del archivo en memoria de blobs — duplicados, porque lo que se
   * dibuja es el bitmap ya rasterizado, no el blob. En un telefono de 1 GB
   * Chrome pagina eso a disco y se siente como tirones de I/O, no como un
   * error limpio, asi que no aparecia en ningun bench.
   *
   * Se conserva lo ultimo usado: sirve para el refinado por zoom, que vuelve a
   * pedir el mismo recurso enseguida. Lo que se desaloja se vuelve a pedir por
   * rango HTTP si hace falta.
   */
  const cacheBlobs = new Map<string, Blob>();
  const lecturas = new Map<string, Promise<Blob | null>>();
  let bytesEnCache = 0;
  // Antes 16 MB fijos. Junto con el cache de bloques de `RemoteSource`
  // (ver zip.ts), son los dos unicos caminos que tocan los BYTES CRUDOS del
  // archivo -- y los dos ignoraban el dispositivo. Misma derivacion que
  // ahi (25% del presupuesto de buffers, piso 8 MB, techo 48 MB): en gama
  // baja da 12 MB (antes 16), un poco mas ajustado a proposito porque este
  // cache es puramente un lujo de "no volver a pedir por HTTP", no algo de
  // lo que dependa la apertura.
  const MAX_BYTES_BLOBS = Math.max(
    8 * 1024 * 1024,
    Math.min(getBudgets().maxBufferCacheBytes * 0.25, 48 * 1024 * 1024)
  );
  const podarBlobs = () => {
    while (bytesEnCache > MAX_BYTES_BLOBS && cacheBlobs.size > 1) {
      const masViejo = cacheBlobs.keys().next().value as string | undefined;
      if (masViejo === undefined) break;
      const b = cacheBlobs.get(masViejo);
      cacheBlobs.delete(masViejo);
      bytesEnCache -= b ? b.size : 0;
    }
  };
  let cerrado = false;

  const bytesRecursos = ids.reduce((n, id) => n + (sizes[id] || 0), 0);
  const bytesTree = zip.get(nombreTree)?.compressedSize ?? 0;

  const doc: Document = {
    layers,
    bbox: globalBbox,
    resourceIds: ids,
    resourceSizes: sizes,
    totalBytes: fuente.size,
    camara,
    bytesNecesarios: bytesTree + bytesRecursos,
    async loadResource(id: string) {
      if (cerrado) return null;
      const hit = cacheBlobs.get(id);
      if (hit) {
        // Renovar la posicion en la cola de uso.
        cacheBlobs.delete(id);
        cacheBlobs.set(id, hit);
        return hit;
      }
      // Si ya hay una lectura EN VUELO para este recurso, se espera esa. Sin
      // esto, dos pedidos simultaneos del mismo id (pasa cuando el refinado
      // por zoom se cruza con la carga del anillo) bajaban y materializaban
      // dos Blobs de varios MB del mismo contenido.
      const enVuelo = lecturas.get(id);
      if (enVuelo) return enVuelo;

      const nombre = porId.get(id);
      if (!nombre) return null;
      const tarea = (async () => {
        try {
          const blob = await zip.readBlob(nombre);
          if (cerrado) return null;
          cacheBlobs.set(id, blob);
          bytesEnCache += blob.size;
          podarBlobs();
          return blob;
        } catch (e) {
          console.error("No se pudo leer el recurso", id, nombre, e);
          return null;
        } finally {
          lecturas.delete(id);
        }
      })();
      lecturas.set(id, tarea);
      return tarea;
    },
    async prefetchResources(ids: string[]) {
      if (cerrado) return;
      const nombres = ids.map((id) => porId.get(id)).filter((n): n is string => !!n);
      if (nombres.length === 0) return;
      try {
        await zip.prefetch(nombres);
      } catch {
        // Es solo un adelanto; si falla, cada recurso se pide por su cuenta.
      }
    },
    close() {
      cerrado = true;
      cacheBlobs.clear();
      lecturas.clear();
      bytesEnCache = 0;
      if (fuente instanceof RemoteSource) fuente.liberar();
    },
  };
  return doc;
}

/**
 * Archivo .concepts abierto UNA sola vez, del que se pueden sacar tanto la
 * vista previa como el documento.
 *
 * Importa porque leer el indice del zip cuesta una ida y vuelta HTTP (~1,7 s
 * a traves del proxy de Drive): abrir dos lectores distintos —uno para el
 * thumbnail y otro para parsear— pagaba ese costo dos veces, y ademas volvia
 * a pedir bytes que ya estaban en el cache de bloques del primero.
 */
export interface ConceptsFile {
  /** Vista previa embebida (thumb.jpg). null si el archivo no la trae. */
  thumbnail(): Promise<Blob | null>;
  /** Documento completo (trazos + capas). Los recursos siguen a demanda. */
  parse(): Promise<Document>;
  close(): void;
  totalBytes: number;
}

export async function openConceptsSource(fuente: ZipSource): Promise<ConceptsFile> {
  const zip = await ZipArchive.open(fuente);
  return {
    totalBytes: fuente.size,
    async thumbnail() {
      const nombre = zip.names().find((n) => /(^|\/)thumb\.jpe?g$/i.test(n));
      // Esto SI es "no hay vista previa": no hay entrada `thumb.jpg` en el
      // zip, nada que reintentar.
      if (!nombre) return null;
      // Pero un fallo de LECTURA (502 esporadico del proxy, cortada de red
      // a mitad del rango -- ambos documentados como reales en
      // driveClient.ts) es otra cosa completamente distinta, y antes se
      // trataba igual: se devolvia `null` sin reintentar. `thumbnailDeArchivo`
      // interpreta `null` como "no trae vista previa" y cae al camino caro
      // (`archivo.parse()` + rasterizar cada PDF con pdf.js): segundos de
      // CPU y ~10x los datos para producir una miniatura de 192px que
      // estaba a UN REINTENTO de distancia. Un solo reintento corto cubre
      // el caso comun (falla transitoria) sin demorar mucho el caso real de
      // "de verdad no se puede leer".
      try {
        return await zip.readBlob(nombre, "image/jpeg");
      } catch {
        await new Promise((r) => setTimeout(r, 400));
        try {
          return await zip.readBlob(nombre, "image/jpeg");
        } catch {
          return null;
        }
      }
    },
    parse: () => documentoDesdeZip(zip, fuente),
    close() {
      if (fuente instanceof RemoteSource) fuente.liberar();
    },
  };
}

/** Abre un archivo remoto (por rangos) una sola vez. */
export async function openConceptsRemote(
  url: string,
  headers: Record<string, string> = {},
  opts: ParseOptions & { size?: number } = {}
): Promise<ConceptsFile> {
  const source = await RemoteSource.open(url, headers, {
    size: opts.size,
    signal: opts.signal,
    onBytes: opts.onBytes,
  });
  return openConceptsSource(source);
}

/** Abre un archivo local elegido por el usuario (sin cargarlo entero). */
export async function openConceptsLocal(file: File): Promise<ConceptsFile> {
  return openConceptsSource(new FileSource(file));
}

/** Compat: parsear desde un ArrayBuffer ya en memoria. */
export async function parseConceptsFile(fileBuffer: ArrayBuffer): Promise<Document> {
  return parseConceptsSource(new BufferSource(fileBuffer));
}

/** Parsear un archivo local elegido por el usuario, sin cargarlo entero. */
export async function parseConceptsLocalFile(file: File): Promise<Document> {
  return parseConceptsSource(new FileSource(file));
}

/**
 * Parsear un archivo REMOTO leyendo por rangos HTTP. Es el camino normal de
 * la app: baja el indice del zip + tree.pack (~1 MB) y despues cada recurso
 * colocado a demanda.
 */
export async function parseConceptsRemote(
  url: string,
  headers: Record<string, string> = {},
  opts: ParseOptions & { size?: number } = {}
): Promise<Document> {
  const source = await RemoteSource.open(url, headers, {
    size: opts.size,
    signal: opts.signal,
    onBytes: opts.onBytes,
  });
  return parseConceptsSource(source, opts);
}

/**
 * Resuelve, para cada recurso COLOCADO en una capa, cual entrada del zip le
 * corresponde. El mapeo id -> archivo se hace por nombre
 * (resources/<uuid>.<ext>) comparando el uuid sin guiones, que es como venia
 * haciendose. No materializa nada: solo arma el indice.
 */
function mapearRecursos(zip: ZipArchive, layers: Layer[]) {
  const usados = new Set<string>();
  layers.forEach((l) => l.images.forEach((img) => img.resourceId && usados.add(img.resourceId)));

  const porId = new Map<string, string>();
  const sizes: Record<string, number> = {};
  if (usados.size === 0) return { ids: [] as string[], sizes, porId };

  // Un solo recorrido de las entradas, indexadas por nombre normalizado: con
  // 96 entradas y 19 recursos, el doble for anidado que habia antes hacia
  // casi 2000 comparaciones de strings largos.
  const normalizadas = zip.names().map((n) => ({ real: n, norm: n.replace(/-/g, "") }));

  for (const uuid of usados) {
    // El id puede traer el numero de pagina colgado (`uuid#2`); al zip hay que
    // pedirle el archivo del recurso, que es uno solo para todas sus paginas.
    const plano = uuid.split("#")[0].replace(/-/g, "");
    const hit = normalizadas.find((n) => n.norm.includes(plano));
    if (!hit) continue;
    porId.set(uuid, hit.real);
    sizes[uuid] = zip.get(hit.real)?.compressedSize ?? 0;
  }

  // De menor a mayor: los recursos chicos se rasterizan y aparecen antes, asi
  // el lienzo se va completando en vez de quedarse vacio esperando al PDF de
  // 20 MB.
  const ids = [...porId.keys()].sort((a, b) => (sizes[a] || 0) - (sizes[b] || 0));
  return { ids, sizes, porId };
}

function procesarCapa(nodo: any, idx: number, globalBbox: BBox): Layer {
  const hdr = nodo[1];
  let capaId = "";
  if (Array.isArray(hdr) && hdr.length > 1) {
     capaId = hdr[1];
  }

  const layer: Layer = { id: capaId, index: idx, strokes: [], images: [], texts: [] };

  const items = Array.isArray(nodo) && nodo.length > 2 && Array.isArray(nodo[2]) ? nodo[2] : [];
  for (const item of items) {
    procesarItem(item, layer, globalBbox);
  }

  // La capa tambien puede estar transformada (su cabecera trae una matriz en el
  // indice 4). En todo el corpus local viene siempre en identidad, asi que esto
  // hoy no mueve nada — esta para que un archivo con una capa movida no se
  // dibuje en silencio en el lugar equivocado, que es justo el modo de fallar
  // que tenian los trazos antes de leer SU matriz.
  const mCapa = Array.isArray(hdr) && hdr.length > 4 && Array.isArray(hdr[4]) && hdr[4].length === 16
    ? (hdr[4] as number[])
    : null;
  if (mCapa && !esIdentidad(mCapa)) {
    aplicarTransformDeCapa(layer, mCapa, globalBbox);
  }

  return layer;
}

/**
 * Aplica la matriz de una capa a todo lo que contiene.
 *
 * Se aplica DESPUES de procesar los hijos y en coordenadas de canvas, asi que
 * la matriz tiene que venir por la misma conversion que el resto.
 */
function aplicarTransformDeCapa(layer: Layer, mDoc: number[], globalBbox: BBox) {
  const m = aCanvasTransform(mDoc);
  const escala = escalaDe(m);
  for (const s of layer.strokes) {
    s.bbox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    s.width *= escala;
    for (const p of s.points) {
      const [x, y] = aplicarMatriz(m, p.x, p.y);
      p.x = x; p.y = y;
      if (x < s.bbox.minX) s.bbox.minX = x;
      if (x > s.bbox.maxX) s.bbox.maxX = x;
      if (y < s.bbox.minY) s.bbox.minY = y;
      if (y > s.bbox.maxY) s.bbox.maxY = y;
      if (x < globalBbox.minX) globalBbox.minX = x;
      if (x > globalBbox.maxX) globalBbox.maxX = x;
      if (y < globalBbox.minY) globalBbox.minY = y;
      if (y > globalBbox.maxY) globalBbox.maxY = y;
    }
  }
  for (const img of layer.images) img.transform = componerAfin(m, img.transform);
}

/** Compone dos afines guardadas en matrices 4x4 (solo 0,1,4,5,12,13). */
function componerAfin(A: number[], B: number[]): number[] {
  const r = B.slice();
  r[0] = A[0] * B[0] + A[4] * B[1];
  r[1] = A[1] * B[0] + A[5] * B[1];
  r[4] = A[0] * B[4] + A[4] * B[5];
  r[5] = A[1] * B[4] + A[5] * B[5];
  r[12] = A[0] * B[12] + A[4] * B[13] + A[12];
  r[13] = A[1] * B[12] + A[5] * B[13] + A[13];
  return r;
}

function procesarItem(item: any, layer: Layer, globalBbox: BBox) {
  if (!Array.isArray(item) || item.length === 0) return;

  const tipo = item[0];

  // Imagen colocada: si de verdad lo es, ya quedo emitida y no hay que seguir
  // recorriendo adentro.
  if ((tipo === 8 || tipo === 7) && Array.isArray(item[1]) && emitirImagen(item, layer, tipo === 7)) return;

  // Texto de la herramienta de texto.
  if (tipo === 13 && Array.isArray(item[1]) && emitirTexto(item, layer)) return;

  // Todo lo demas (incluidos los envoltorios de trazo — tipo 11 y tipo 9 — y
  // las subcapas tipo 1/4) se recorre igual: `buscarElementos` despacha por
  // tipo en cualquier nivel de anidamiento.
  buscarElementos(item, layer, globalBbox);
}

/**
 * Emite una imagen colocada en el lienzo. Devuelve `true` si el item de verdad
 * era una imagen (y quedo agregada a la capa).
 *
 * Hay DOS tipos:
 *   8 = el que usa Concepts para los PDF
 *   7 = el que usa para las fotos (jpg)
 *
 * Los dos traen las mismas piezas (uuid del recurso, tamaño y matriz), solo
 * que con campos intermedios distintos, asi que se extraen igual. Soportar
 * solo el 8 hacia que un dibujo de fotos no mostrara NINGUNA imagen: un
 * archivo de 87 MB con 29 fotos se abria con el lienzo vacio y las
 * anotaciones sueltas, porque el parser no encontraba nada que colocar.
 *
 * IMPORTANTE: esta funcion NO vuelve a llamar al recorrido. Antes la rama de
 * imagen llamaba a `buscarElementos` cuando el item no validaba, y ahora que
 * `buscarElementos` tambien reconoce imagenes eso seria un bucle infinito.
 */
/**
 * Emite un texto (item tipo 13). Devuelve `true` si el item lo era.
 *
 * Cuerpo: `[1, <cabecera>, "el texto", <matriz extra>]`. Ver `TextElement` para
 * por que se usa la matriz de la cabecera y se descarta la extra.
 *
 * El tamaño de la letra NO viene como un numero aparte: esta metido en la
 * escala de la matriz. Se dibuja con una altura de 1 unidad en el espacio del
 * elemento y la matriz se encarga del resto, que es lo mismo que hacemos con
 * las imagenes.
 */
function emitirTexto(item: any, layer: Layer): boolean {
  const cuerpo = item[1];
  if (!Array.isArray(cuerpo)) return false;

  const texto = cuerpo.find((x: any) => typeof x === "string");
  if (!texto) return false;

  const hdr = Array.isArray(cuerpo[1]) ? cuerpo[1] : null;
  const mat = hdr ? matrizDeCabecera(hdr) : null;
  if (!mat) return false;

  let elementoId = "";
  if (hdr) {
    const u = hdr.find((x: any) => typeof x === "string" && x.includes("-"));
    if (u) elementoId = u;
  }

  // El color vive dentro del estilo, a una profundidad que cambia segun la
  // herramienta; se busca el primer RGBA (los ext type 4 se decodifican como
  // array de 4 numeros) en vez de indexar a ciegas.
  let color = { r: 0, g: 0, b: 0, a: 1, hex: "#000000" };
  const buscarColor = (o: any): number[] | null => {
    if (!Array.isArray(o)) return null;
    if (o.length === 4 && o.every((v) => typeof v === "number") && o.every((v) => v >= 0 && v <= 1)) return o;
    for (const x of o) { const r = buscarColor(x); if (r) return r; }
    return null;
  };
  const col = hdr ? buscarColor(hdr) : null;
  if (col) color = { r: col[0], g: col[1], b: col[2], a: col[3], hex: rgbaToHex(col[0], col[1], col[2], col[3]) };

  layer.texts.push({
    id: elementoId,
    text: texto,
    color,
    transform: aCanvasTransform(mat),
  });
  return true;
}

function emitirImagen(item: any, layer: Layer, esFoto: boolean): boolean {
  const cuerpo: any[] = item[1];
  {
    const interno = Array.isArray(cuerpo) && cuerpo.length > 1 && Array.isArray(cuerpo[1]) ? cuerpo[1] : [];

    let elementoId = "";
    const u = interno.find(x => typeof x === "string" && x.includes("-"));
    if (u) elementoId = u;

    let resourceId = "";
    const ru = cuerpo.find(x => typeof x === "string" && x.includes("-"));
    if (ru) resourceId = ru;

    // UN MISMO PDF puede estar colocado varias veces, una por pagina: en el
    // item, justo despues del uuid del recurso, viene el numero de pagina.
    // Sin leerlo, todas esas colocaciones comparten el mismo id y terminan
    // mostrando LA MISMA pagina (la primera), porque tanto el cache como el
    // rasterizador indexan por id de recurso. El plano dibujado no era el que
    // corresponde, asi que las anotaciones de la pagina 2 caian sobre el
    // dibujo de la pagina 1 — se veia como un problema de posicion cuando en
    // realidad la posicion estaba bien y el CONTENIDO estaba mal.
    //
    // El numero se cuelga del id (`uuid#2`) para que el cache, el pool de
    // workers y el rasterizado queden separados por pagina sin tener que
    // cambiar la forma de todo lo que ya indexa por resourceId. La pagina 0
    // se deja SIN sufijo a proposito: es la unica que existe en un PDF de una
    // sola pagina (la enorme mayoria del corpus), asi que esos archivos
    // conservan exactamente el id de antes y no cambian en nada.
    if (ru) {
      const iRu = cuerpo.indexOf(ru);
      const pag = iRu >= 0 ? cuerpo[iRu + 1] : null;
      if (typeof pag === "number" && Number.isInteger(pag) && pag > 0) {
        resourceId = `${ru}#${pag}`;
      }
    }

    let width = 0, height = 0;
    const tam = cuerpo.find(x => Array.isArray(x) && x.length === 2 && typeof x[0] === "number");
    if (tam) { width = tam[0]; height = tam[1]; }

    let transform = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    const mat = interno.find(x => Array.isArray(x) && x.length === 16);
    if (mat) transform = mat;

    // La matriz posiciona el CENTRO del recurso, no su esquina superior
    // izquierda: hay que trasladar el contenido media caja antes de aplicarla.
    //
    // Aca vivio mucho tiempo esta misma resta pero condicionada a que la parte
    // lineal fuera la identidad. Con esa condicion arreglaba los 3 archivos del
    // corpus que tenian recursos sin rotar ni escalar y dejaba mal TODOS los
    // demas — que son la enorme mayoria, porque un plano insertado casi siempre
    // viene rotado 90 grados y a media escala.
    //
    // Como se confirmo que el centro es lo correcto: en `Fede y Franco/HO/
    // Drawing` las anotaciones caen, segun el thumb.jpg que renderiza la propia
    // app, entre el 32% y el 75% del ancho de la hoja. Tratando la traslacion
    // como esquina caian entre el 80% y el 100% (o sea, encima del rotulo y
    // afuera de la hoja); tratandola como centro caen entre el 26% y el 66%.
    transform = transform.slice();
    transform[12] -= (transform[0] * width) / 2 + (transform[4] * height) / 2;
    transform[13] -= (transform[1] * width) / 2 + (transform[5] * height) / 2;

    // Solo se acepta si de verdad parece una imagen colocada. Sin esta guarda,
    // aceptar el tipo 7 a ciegas podria fabricar elementos vacios a partir de
    // cualquier otra cosa que comparta la etiqueta.
    if (resourceId && width > 0 && height > 0) {
      layer.images.push({
        id: elementoId,
        resourceId,
        width,
        height,
        isPhoto: esFoto,
        transform: aCanvasTransform(transform)
      });
      return true;
    }
    // Si no cumple, el que llamo sigue recorriendo adentro. Devolver false (en
    // vez de llamar al recorrido desde aca) es lo que evita el bucle infinito
    // ahora que `buscarElementos` tambien reconoce imagenes.
    return false;
  }
}

function buscarElementos(o: any, layer: Layer, globalBbox: BBox) {
  if (!Array.isArray(o)) return;

  const blobs = o.filter(x => x instanceof Uint8Array && x.length >= 32 && x.length % 16 === 0);

  if (blobs.length > 0 && o.length > 2 && o[0] === 6 && Array.isArray(o[1])) {
    emitirTrazo(o, blobs[0], layer, globalBbox);
    return;
  }

  // Una imagen puede estar ANIDADA dentro de un grupo en vez de colgar directo
  // de la capa. Antes esta funcion solo sabia reconocer trazos, asi que esas
  // imagenes nunca se emitian y desaparecian en silencio: no se dibujaban mal
  // ubicadas, directamente no se dibujaban.
  if ((o[0] === 7 || o[0] === 8) && Array.isArray(o[1]) && emitirImagen(o, layer, o[0] === 7)) return;
  if (o[0] === 13 && Array.isArray(o[1]) && emitirTexto(o, layer)) return;

  for (const x of o) {
    buscarElementos(x, layer, globalBbox);
  }
}

function emitirTrazo(o: any, blob: Uint8Array, layer: Layer, globalBbox: BBox) {
  const hdr = o[1];

  const stroke: Stroke = {
    id: "",
    points: [],
    color: { r: 0, g: 0, b: 0, a: 1, hex: "#000000" },
    width: 1,
    bbox: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  };

  try {
    const bw = hdr[1][1];
    const core = bw[1];
    const col = core[2];
    if (Array.isArray(col) && col.length >= 4) {
      stroke.color = {
        r: col[0], g: col[1], b: col[2], a: col[3],
        hex: rgbaToHex(col[0], col[1], col[2], col[3])
      };
    }
    stroke.width = bw[3] || 1;
  } catch {
    // fallback
  }

  const u = hdr.find((x: any) => typeof x === "string" && x.includes("-"));
  if (u) stroke.id = u;

  // Matriz de colocacion del trazo (ver `matrizDeCabecera`). Si el usuario lo
  // movio/roto/escalo, los puntos guardados siguen siendo los originales y toda
  // la edicion vive aca.
  const mat = matrizDeCabecera(hdr);
  const transformar = mat !== null && !esIdentidad(mat);
  // Un trazo escalado tiene que engordar/adelgazar con su escala: sin esto una
  // anotacion agrandada al doble se dibuja del grosor con el que se trazo.
  if (transformar) stroke.width *= escalaDe(mat!);

  const n = Math.floor(blob.length / 16);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);

  for (let i = 0; i < n; i++) {
    let px = view.getFloat32(i * 16, true);
    let py = view.getFloat32(i * 16 + 4, true);
    if (transformar) [px, py] = aplicarMatriz(mat!, px, py);
    // Documento (Y arriba) -> canvas (Y abajo). Ver `aCanvasPunto`.
    const [x, y] = aCanvasPunto(px, py);
    const p = view.getUint16(i * 16 + 8, true);
    const t1 = view.getUint16(i * 16 + 10, true);
    const t2 = view.getUint16(i * 16 + 12, true);

    stroke.points.push({ x, y, p, t1, t2 });

    if (x < stroke.bbox.minX) stroke.bbox.minX = x;
    if (x > stroke.bbox.maxX) stroke.bbox.maxX = x;
    if (y < stroke.bbox.minY) stroke.bbox.minY = y;
    if (y > stroke.bbox.maxY) stroke.bbox.maxY = y;

    if (x < globalBbox.minX) globalBbox.minX = x;
    if (x > globalBbox.maxX) globalBbox.maxX = x;
    if (y < globalBbox.minY) globalBbox.minY = y;
    if (y > globalBbox.maxY) globalBbox.maxY = y;
  }

  layer.strokes.push(stroke);
}
