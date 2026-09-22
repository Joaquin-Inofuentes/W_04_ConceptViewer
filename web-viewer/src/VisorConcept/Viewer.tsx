import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle, useMemo, useCallback, memo } from "react";
import type { Document, Stroke } from "./parser";
import {
  loadResourceImages,
  releaseResourceImages,
  drawnSizes,
  dibujarRecurso,
  liberarImagen,
  safeExportScale,
  exportFueRecortado,
  proveedorEnStreaming,
  statsCache,
  tiempos,
  soltarPdfsAbiertos,
  programarCierreWorkers,
  cancelarCierreWorkers,
  compararOrdenDibujo,
  dibujarTexto,
  ALTO_LINEA_TEXTO,
} from "../Gallery/renderCore";
import type { RecursoRasterizado } from "../Gallery/renderCore";
import { dprVivo, getBudgets, maxCanvasSide } from "../device";
import { coloresLienzo, temaGuardado } from "../theme";
import type { Tema } from "../theme";

export interface LayerConfig {
  visible: boolean;
  opacity: number;
}

interface ViewerProps {
  doc: Document | null;
  /** Id del archivo en Drive, para el cache persistente de rasterizados. */
  fileId?: string | null;
  layerConfigs: Record<string, LayerConfig>;
  isolatedLayer: string | null;
  /** Opacidad aplicada SOLO a las imagenes/fotos/PDFs, independiente de la
   * opacidad por capa: a veces el usuario quiere ver los trazos a pleno pero
   * las fotos de fondo mas tenues (o al reves), y la opacidad por capa no
   * sirve para eso porque una capa mezcla trazos e imagenes. */
  imageOpacity?: number;
  onImagesLoaded?: (images: Record<string, string>) => void;
  /** Avisa cuando terminaron de cargarse los recursos embebidos (fotos/PDFs),
   * que es lo unico lento al abrir un dibujo pesado. */
  onResourcesReady?: () => void;
  /** Avance de carga de recursos, para mostrarlo en la UI. */
  onResourceProgress?: (listos: number, total: number) => void;
  /** Avisa cuantos planos se estan trabajando y de que tipo: los que hay que
   * TRAER (no existen todavia en el dispositivo, hay que bajarlos) y los que
   * solo hay que AFINAR (ya se ven, a menos resolucion). No es lo mismo para
   * el usuario: traer puede tardar 30 s en 4G, afinar dura un instante. */
  onRefinando?: (activo: boolean, aAfinar: number, aTraer: number) => void;
  /**
   * Bytes que de verdad se van a bajar para el encuadre inicial.
   *
   * El documento declara el peso de TODOS los recursos colocados (250 MB en el
   * dibujo mas pesado), pero el visor solo baja los que se ven y son lo
   * bastante grandes: ~11 MB. Sin este dato la barra calculaba el porcentaje y
   * el tiempo restante contra los 250 MB y anunciaba "faltan 14 min" en una
   * apertura de 50 s.
   */
  onBytesPrevistos?: (bytes: number) => void;
  /** El usuario toco el lienzo: ya no hay que taparlo con la vista previa. */
  onPrimerGesto?: () => void;
  /** Cuantos planos se dieron por perdidos tras varios intentos. Con esto la
   * app puede decirlo en vez de afirmar que termino de cargar. */
  onFallidos?: (cuantos: number) => void;
  /**
   * Avisos NO bloqueantes del export ("el lienzo esta vacio", "se exporto a
   * menor resolucion por el limite de RAM del dispositivo"). Antes el primero
   * era un `alert()` -- congela la pestaña entera, incluido el render loop, y
   * en movil tapa toda la pantalla con el chrome nativo del navegador -- y el
   * segundo solo iba a la consola, invisible para cualquiera que no tenga las
   * devtools abiertas.
   */
  onExportNotice?: (mensaje: string) => void;
  /**
   * Se dispara UNA sola vez, la primera vez que todo lo que cae dentro del
   * viewport actual ya tiene bitmap dibujable (o el documento no tiene
   * imagenes). Es la condicion de "no hay nada a medio cargar visible":
   * antes la vista previa se retiraba con el PRIMER recurso que llegaba
   * (`progresoRecursos.listos > 0` en App.tsx), dejando ver el resto de los
   * planos como huecos negros durante el resto de la carga. Con esto la
   * vista previa se sostiene hasta que reemplazarla no deja ningun hueco
   * visible.
   */
  onCoberturaLista?: () => void;
}

export interface ViewerHandle {
  exportDrawing: (format: 'png' | 'jpg' | 'pdf', zoomAll?: boolean) => Promise<void>;
  /** Encuadra todo el dibujo en pantalla (el "zoom all" del boton). */
  zoomAll: () => void;
  /** Acerca/aleja un escalon fijo, centrado en el medio de la pantalla (los
   * botones +/- de la barra de herramientas). */
  zoomIn: () => void;
  zoomOut: () => void;
  /**
   * Encuadra el N-esimo plano colocado (orden de aparicion en el documento,
   * el mismo que usa la galeria de imagenes). Sirve para los botones
   * "plano siguiente/anterior": en un dibujo con varias laminas (como los
   * PDF de electricidad con una hoja por piso) no hay que ir a pulso a
   * buscar cada una a mano.
   */
  irAPlano: (indice: number) => void;
  /** Cuantos planos (imagenes colocadas, no recursos unicos) hay para
   * navegar con `irAPlano`. */
  cantidadPlanos: () => number;
  /** Metricas en vivo, para benchmarks y diagnostico. */
  getStats: () => ViewerStats;
  /**
   * Pide una version COMPLETA (sin recortar) y en alta resolucion de un
   * recurso puntual, para la vista de foto a pantalla completa.
   *
   * Independiente del cache de canvas (`imagesRef`): ese cache guarda el
   * recurso a la resolucion que pide el LIENZO, que a zoom bajo es mucho
   * menos de lo que se quiere ver a pantalla completa. Rasteriza de nuevo,
   * aparte, a una resolucion pensada para pantalla completa (no la de export
   * a 600 DPI, que para una foto en pantalla es derrochar RAM), y con la
   * misma orientacion con la que el plano esta colocado en el dibujo.
   * Devuelve un data URL listo para <img>, o null si no se pudo.
   */
  obtenerImagenCompleta: (resourceId: string) => Promise<string | null>;
}

export interface ViewerStats {
  /** Cadencia real: 1000 / mediana del hueco entre frames presentados. */
  fps: number;
  /** Hueco del percentil 95, en ms. Es el numero que delata los tirones. */
  p95FrameMs: number;
  /** Frames con hueco mayor a 32 ms (dos cuadros perdidos a 60 Hz). */
  framesLargos: number;
  /** Lo que costo DIBUJAR el ultimo frame (distinto de la cadencia). */
  ultimoFrameMs: number;
  /**
   * Desglose por fase del ultimo frame DIBUJADO (no del hueco de cadencia).
   * Siempre se mide: `performance.now()` en 5 puntos por frame es un costo
   * insignificante frente al propio dibujado, y sin esto "el frame tarda
   * 40ms" no dice si el tiempo se va en imagenes, en trazos sueltos o en la
   * grilla — que es exactamente lo que hace falta saber para optimizar el
   * correcto.
   */
  faseGridMs: number;
  faseImagenesMs: number;
  faseTrazosMs: number;
  faseTrazosFusionadosMs: number;
  /** Cuantas imagenes/trazos realmente se dibujaron en el ultimo frame (no
   * los colocados en el documento: los que sobrevivieron al descarte por
   * frustum). Sin esto un frame lento en un dibujo con 3000 trazos y uno
   * lento en un dibujo con 30000 pero con solo 40 visibles se ven iguales. */
  itemsImagenDibujados: number;
  itemsTrazoDibujados: number;
  gruposFusionadosDibujados: number;
  framesDibujados: number;
  recursosCargados: number;
  pixelesImagenes: number;
  dpr: number;
}

/** Headroom de resolucion sobre el zoom actual. Se arranca bajo para que el
 * dibujo aparezca rapido; si el usuario se acerca, `pedirRefinado` vuelve a
 * rasterizar mas grande. Rasterizar un PDF cuesta mas o menos lineal en
 * pixeles, asi que subir esto a 2 cuadruplica el tiempo de apertura. */
const RESOURCE_QUALITY = 1.25;

/**
 * Cuanto se carga POR AFUERA de la pantalla, en fracciones de viewport.
 *
 * Es el margen que hace que un paneo normal no descubra recuadros vacios: lo
 * que esta a medio viewport de distancia ya tiene bitmap cuando llegas. Subirlo
 * gasta mas red y RAM sin que se note; bajarlo a 0 hace que cada movimiento
 * muestre huecos hasta que rasteriza.
 */
const MARGEN_ANILLO = 0.6;

/** A que fraccion de la resolucion se trae el anillo. Media escala = un cuarto
 * de los pixeles, y al panear hacia alla se refina solo. */
const ESCALA_ANILLO = 0.5;

/** Cuanto puede quedarse corta la resolucion cargada antes de volver a
 * rasterizar. Con 1 se re-rasterizaria ante el menor movimiento de zoom. */
const TOLERANCIA_ESCALA = 1.1;

/**
 * Que parte del presupuesto de RAM se reparte entre los recursos "hot" (los
 * que el usuario esta mirando), dejando el resto para el anillo de fondo.
 *
 * Antes el reparto era "entre competidores + 1", que es lo mismo que reservar
 * una porcion del tamaño de un recurso entero. Con UN solo recurso eso deja la
 * MITAD del presupuesto sin usar, y donde mas se nota es en gama baja, que es
 * justo donde cada pixel importa: un telefono con 12 Mpx de techo se quedaba
 * en 6. Con una reserva porcentual, ese mismo telefono llega a 9 Mpx (36 MB de
 * los 48 que el presupuesto permite) y las gamas media y alta no cambian,
 * porque ahi manda el otro techo (`maxPixelsPerResource * 4`).
 */
const FRACCION_PLENA = 0.75;

/**
 * Cuanto mas grande que la ventana se dibuja el lienzo, por lado.
 *
 * El canvas se pinta un 25% mas ancho y un 25% mas alto POR CADA LADO (o sea
 * un 50% mas de ancho y de alto en total) y se coloca corrido esa misma
 * cantidad hacia arriba y hacia la izquierda, con el contenedor recortando lo
 * que sobra. El usuario ve exactamente lo mismo que antes; la diferencia es
 * que ahora hay lienzo dibujado FUERA de cuadro.
 *
 * Para que sirve: durante un gesto el frame no se redibuja, se corre con un
 * `transform` de CSS. Sin margen, correrlo destapa el borde — sin dibujo y
 * sin grilla, porque ahi no hay canvas. Con el margen, ese borde destapado
 * cae fuera de lo que se ve: el paneo y el zoom salen de una zona ya
 * dibujada. Se sigue re-dibujando de verdad al pasar `UMBRAL_REANCLAJE`, que
 * es a proposito MENOR que este margen, asi que el hueco nunca llega a
 * asomar.
 *
 * Cuesta 2,25x de area por frame (1,5 x 1,5), y ese precio se midio antes de
 * darlo por bueno: con la CPU frenada 6x y el presupuesto de gama baja, el p95
 * de frame da 8,0 ms con este margen contra 7,4 ms con uno de 0,15 — ruido. El
 * canvas de un telefono es chico (0,85 Mpx aca), asi que el relleno no es el
 * cuello y no hace falta un margen distinto por gama.
 */
const MARGEN_LIENZO = 0.25;

/**
 * Cuanto se puede correr el lienzo por CSS antes de redibujarlo de verdad.
 *
 * Durante un gesto no se redibuja: se desplaza el ultimo frame con un
 * `transform`, gratis para el hilo principal. El borde que eso destapa cae
 * dentro del margen y no se ve, pero solo hasta que el corrimiento se come el
 * margen entero: pasado ese punto hay que dibujar un frame de verdad y
 * re-anclar el gesto ahi. Por eso se deriva del margen (al 80%) en vez de
 * fijarlo a mano: asi los dos no pueden quedar desincronizados.
 *
 * Son unos pocos redibujos por arrastre, no uno por movimiento: el ahorro del
 * transform CSS se mantiene.
 */
const UMBRAL_REANCLAJE = MARGEN_LIENZO * 0.8;

/** Lo mismo para el zoom: un frame viejo estirado mas que esto se ve borroso
 * y conviene volver a dibujarlo nitido. */
const UMBRAL_REANCLAJE_ZOOM = 1.4;

/** Espera tras el ultimo gesto antes de tocar la red. Suficiente para no
 * disparar en cada paso de la rueda, corto para que el hueco no se note. */
const DEBOUNCE_SINCRONIZAR = 220;

/**
 * Lado minimo en pixeles de pantalla para que valga la pena bajar un recurso.
 *
 * Medido sobre los tres dibujos mas pesados: los planos que se leen ocupan
 * 80-700 px de lado y suman 11 MB; las fotos adjuntas ocupan 1-5 px y suman
 * 252 MB. Con el umbral en 24 px se baja el 4% de los bytes para ver el 100%
 * de lo que se distingue, y cada foto llega cuando te acercas a ella.
 */
const LADO_MINIMO_PX = 24;

/**
 * Lado en pixeles a partir del cual un recurso cargado cuenta como
 * "resolucion plena" para el tope FIFO de 2 (ver hotFifoRef).
 *
 * Hace falta para no confundir esto con una vista general: al encuadrar un
 * dibujo entero, TODOS sus planos estan "visibles" a la vez pero cada uno
 * ocupa poco lado en pantalla (miniaturas), no algo parecido a full HD. Sin
 * este umbral el primer render ya llenaba (y de sobra) el tope con esas
 * miniaturas. 900 px separa con margen una miniatura de overview (decenas a
 * pocos cientos de px) de un plano al que el usuario se acerco de verdad.
 */
const UMBRAL_HOT_LADO_PX = 900;

/** Un grupo de trazos que comparten estado de dibujo, unidos en un solo
 * Path2D para poder pintarlos con una sola llamada. */
interface FusionTrazos {
  path: Path2D;
  color: string;
  globalAlpha: number;
  width: number;
  layerId: string;
  layerIndex: number;
}

interface CachedStroke {
  kind: "stroke";
  pathFull: Path2D;
  minX: number; minY: number; maxX: number; maxY: number;
  color: string;
  globalAlpha: number;
  width: number;
  layerId: string;
  layerIndex: number;
}

interface CachedImage {
  kind: "image";
  resourceId: string;
  transform: number[];
  minX: number; minY: number; maxX: number; maxY: number;
  width: number;
  height: number;
  layerId: string;
  layerIndex: number;
  isPhoto?: boolean;
}

interface CachedText {
  kind: "text";
  lineas: string[];
  transform: number[];
  minX: number; minY: number; maxX: number; maxY: number;
  color: string;
  globalAlpha: number;
  layerId: string;
  layerIndex: number;
}

type CachedItem = CachedStroke | CachedImage | CachedText;

/**
 * Orden de lectura (izquierda->derecha, arriba->abajo) de una lista de cajas.
 *
 * Agrupa en filas por superposicion vertical (no exige alineacion perfecta:
 * dos planos de alturas distintas quedan en la misma fila si sus rangos Y se
 * tocan) y dentro de cada fila ordena por X. `minY`/`maxY` ya estan en
 * espacio de CANVAS (Y crece hacia abajo: `aCanvasTransform` en parser.ts
 * invierte el Y-arriba del documento al parsear), asi que Y ascendente es
 * directamente arriba->abajo. Antes `cantidadPlanos`/`irAPlano` navegaban en
 * el orden en que Concepts guardo cada plano en el archivo, que no tiene
 * ninguna relacion con donde quedaron colocados en el lienzo.
 */
function ordenDeLectura<T extends { minX: number; minY: number; maxX: number; maxY: number }>(cajas: T[]): T[] {
  const ordenadasPorY = [...cajas].sort((a, b) => a.minY - b.minY);
  const filas: T[][] = [];
  let filaMaxY = -Infinity;
  for (const c of ordenadasPorY) {
    if (filas.length > 0 && c.minY < filaMaxY) {
      filas[filas.length - 1].push(c);
      if (c.maxY > filaMaxY) filaMaxY = c.maxY;
    } else {
      filas.push([c]);
      filaMaxY = c.maxY;
    }
  }
  const resultado: T[] = [];
  for (const fila of filas) {
    fila.sort((a, b) => a.minX - b.minX);
    resultado.push(...fila);
  }
  return resultado;
}

/**
 * Arma el Path2D de un trazo salteando puntos que estan a menos de
 * `tolerancia` unidades del ultimo punto conservado. Los trazos de Concepts
 * vienen sobremuestreados (puntos separados por decimas de unidad), asi que
 * con una tolerancia chica se recorta mucho la cantidad de segmentos sin
 * ningun cambio visible — y el costo de dibujar por frame baja igual.
 */
function buildPath(points: Stroke["points"], tolerancia: number): Path2D {
  const path = new Path2D();
  if (points.length === 0) return path;
  path.moveTo(points[0].x, points[0].y);
  let lastX = points[0].x;
  let lastY = points[0].y;
  const tol2 = tolerancia * tolerancia;
  for (let i = 1; i < points.length - 1; i++) {
    const dx = points[i].x - lastX;
    const dy = points[i].y - lastY;
    if (dx * dx + dy * dy < tol2) continue;
    path.lineTo(points[i].x, points[i].y);
    lastX = points[i].x;
    lastY = points[i].y;
  }
  if (points.length > 1) {
    const last = points[points.length - 1];
    path.lineTo(last.x, last.y);
  }
  return path;
}

const ViewerBase = forwardRef<ViewerHandle, ViewerProps>(({ doc, fileId, layerConfigs, isolatedLayer, imageOpacity, onImagesLoaded, onResourcesReady, onResourceProgress, onRefinando, onBytesPrevistos, onPrimerGesto, onFallidos, onCoberturaLista, onExportNotice }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const budgets = useMemo(() => getBudgets(), []);

  // El lienzo dibuja en canvas, asi que no se entera del tema por CSS: hay
  // que releer los colores y repintar cuando cambia.
  const [tema, setTema] = useState<Tema>(() => temaGuardado());
  const coloresRef = useRef(coloresLienzo(tema));
  useEffect(() => {
    coloresRef.current = coloresLienzo(tema);
  }, [tema]);

  // Core state moved to refs for high performance
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const sizeRef = useRef({ width: 0, height: 0 });

  // Cache refs
  const imagesRef = useRef<Record<string, RecursoRasterizado>>({});
  /** Reloj logico de uso, para desalojar por LRU lo que hace mas tiempo que
   * no se ve. Un contador y no Date.now(): dos cargas en el mismo milisegundo
   * tienen que quedar ordenadas igual. */
  const usoRef = useRef<Record<string, number>>({});
  const relojUsoRef = useRef(0);
  /**
   * Cola FIFO de recursos rasterizados a resolucion PLENA (no el anillo, que
   * va a media escala como adelanto).
   *
   * Reportado por un usuario: acercarse a un plano hasta full HD y panear
   * volvia a cargar el plano de vuelta. Causa: `desalojarLejanos` desaloja
   * por LRU contra el presupuesto de RAM del dispositivo, y con varios
   * planos en pantalla el que se acaba de ver en full HD podia salir del
   * presupuesto apenas dejaba de estar "cerca" (fuera del anillo), asi que
   * volver a el rerasterizaba el PDF entero (~4,7 s por plano).
   *
   * Se agrega un tope aparte, chico y fijo (2 planos), que protege del
   * desalojo por RAM a los ultimos dos que llegaron a resolucion plena. Es
   * FIFO y no LRU a proposito: el usuario pidio explicitamente que
   * "volver a mirar" un plano viejo no lo salve de salir cuando entra un
   * tercero, para que el comportamiento sea predecible (los ultimos DOS que
   * se enfocaron, no los mas usados).
   */
  const hotFifoRef = useRef<string[]>([]);
  // Tres, no dos: es lo que el usuario pidio explicitamente ("las 2 o 3
  // imagenes que tenga en RAM visibles full HD"), y con el rasterizado por
  // pagina ENTERA (ver `cargarRecursos`) tres planos pinchados siguen
  // entrando en el presupuesto de RAM del dispositivo — el tope por recurso
  // se reparte contra este mismo numero.
  const MAX_HOT_FIFO = 3;
  /**
   * Recursos que ya llegaron al tope DURO de pixeles con el que se pidieron
   * (`maxPixelsPedido` en `cargarRecursos` — mas alto para lo que esta
   * "hot" que para el anillo de fondo, ver ese comentario). Pedir mas
   * resolucion para uno de estos con ESE MISMO tope nunca va a lograr nada:
   * `necesita()` deja de insistir apenas lo detecta.
   *
   * Hace falta para no repetir, con otro disparador, el mismo bug que la
   * lista "ya cargado" de hotFifoRef vino a arreglar: a zoom muy alto,
   * `necesaria` (lo que se necesitaria para verse nitido) queda MUY por
   * encima de lo que el presupuesto permite, y sin este freno cada gesto de
   * pan o zoom volvia a pedir el recurso entero (el mismo "Afinando..." que
   * nunca mejoraba nada) — comprobado en pruebas: la escala lograda se
   * quedaba fija en ~4.3 contra una escala pedida de ~15, y aun asi se
   * reintentaba en CADA sync. En cambio, si el que se quedo corto fue el
   * presupuesto GLOBAL (compartido con otros recursos en pantalla en ese
   * momento, no el techo de este recurso), no se marca aca: en el proximo
   * intento, con otros recursos ya desalojados, puede conseguir mas.
   */
  // Guarda el TECHO (maxPixelsPedido) con el que se saturo, no un booleano.
  // Antes era `boolean`, y un recurso cargado por el anillo (hot=false, techo
  // chico: budgets.maxPixelsPerResource) que saturaba ESE techo quedaba
  // marcado "tope alcanzado" para siempre — incluyendo cuando despues el
  // usuario se acerca y pasa a pedirse con el techo "hot" (hasta 4x mas
  // grande). `necesita()` devolvia false sin distinguir con QUE techo se
  // habia saturado, y ese plano quedaba borroso el resto de la sesion aunque
  // hubiera presupuesto de sobra para refinarlo. Guardando el numero, se
  // puede comparar contra el techo VIGENTE en cada consulta.
  const topeAlcanzadoRef = useRef<Record<string, number>>({});
  /**
   * Recursos a los que ya se les pidio la version PLENA (todo el recurso, a
   * la maxima resolucion que permite el presupuesto, sin importar el zoom
   * actual). Ver `cargaPlena` en `sincronizarRecursos`.
   *
   * Se marca al pedirla y no al conseguirla a propuesto: una foto chica nunca
   * va a llegar al tope de pixeles (su resolucion nativa manda), y usar el
   * tope como condicion la volveria a pedir en cada sync para siempre.
   */
  const plenoPedidoRef = useRef<Record<string, boolean>>({});
  /**
   * Recursos que YA estan siendo pedidos por una sincronizacion en curso.
   *
   * Sin esto, dos `sincronizarRecursos` que se solapan (la inicial, que
   * espera 1 rAF, y la que dispara `pedirRefinado` a los 220ms tras un
   * gesto) recalculan `sinBitmap`/`aRefinar`/`cargaPlena` cada una por su
   * cuenta y sin saber de la otra: si un PDF tarda segundos en rasterizarse,
   * la segunda lo ve "todavia sin bitmap" y lo vuelve a pedir -- doble
   * viaje de red y doble rasterizado por el mismo recurso, en un pool de
   * apenas 2 workers en gama baja. Abortar la sincronizacion vieja tampoco
   * alcanza: el trabajo ya encolado en el worker sigue corriendo igual.
   */
  const enVueloRef = useRef<Set<string>>(new Set());
  const layerConfigsRef = useRef<Record<string, LayerConfig>>(layerConfigs);
  const isolatedLayerRef = useRef<string | null>(isolatedLayer);
  const imageOpacityRef = useRef<number>(imageOpacity ?? 1);
  const isDirtyRef = useRef(true);
  const canvasSizeRef = useRef({ width: 0, height: 0 });

  // --- Estado del gesto (pan/zoom) ---------------------------------------
  // Durante un gesto NO se re-dibuja la escena: se estira el ultimo frame ya
  // rasterizado (un solo drawImage, ~1 ms fijo). Redibujar 7000 trazos +
  // 19 imagenes por frame costaba 40-50 ms en gama baja, o sea 20 fps y
  // gestos "pegajosos". Al soltar (o al frenar) se re-dibuja nitido.
  const gestoRef = useRef(false);
  /** Pide un dibujo REAL aunque haya un gesto en curso (ver `marcarGesto`). */
  const forzarDibujoRef = useRef(false);
  /** Margen en px con el que se dibujo el ultimo frame (ver MARGEN_LIENZO).
   * Lo necesita el transform del gesto para escalar desde el punto correcto. */
  const margenLienzoRef = useRef({ x: 0, y: 0 });
  /** Da acceso a `limpiarTransformGesto` desde efectos que corren antes de
   * que se defina (el del cambio de tema). */
  const limpiarTransformGestoRef = useRef<() => void>(() => {});
  /** pan/zoom desde el que arranco el gesto en curso. */
  const snapshotViewRef = useRef({ panX: 0, panY: 0, zoom: 1, dpr: 1 });
  const finGestoTimerRef = useRef<number | null>(null);

  // --- Metricas ----------------------------------------------------------
  const statsRef = useRef<ViewerStats>({
    fps: 0,
    p95FrameMs: 0,
    framesLargos: 0,
    ultimoFrameMs: 0,
    faseGridMs: 0,
    faseImagenesMs: 0,
    faseTrazosMs: 0,
    faseTrazosFusionadosMs: 0,
    itemsImagenDibujados: 0,
    itemsTrazoDibujados: 0,
    gruposFusionadosDibujados: 0,
    framesDibujados: 0,
    recursosCargados: 0,
    pixelesImagenes: 0,
    dpr: budgets.maxDpr,
  });
  // Buffer circular en vez de un array con push/shift: shift es O(n) y hace
  // que V8 degrade el array, y esto corre en cada frame.
  const frameTimesRef = useRef<Float32Array>(new Float32Array(120));
  const ringPosRef = useRef(0);
  const ultimoFrameRef = useRef(0);

  // El loop de render arranca solo cuando hay algo que dibujar y se apaga
  // cuando no. Antes corria a 60 Hz para siempre, despertando la CPU (y
  // gastando bateria) aunque la pantalla estuviera quieta.
  const rafRef = useRef<number | null>(null);
  const framesLimpiosRef = useRef(0);
  const renderRef = useRef<() => void>(() => {});

  const requestRedraw = useCallback(() => {
    isDirtyRef.current = true;
    framesLimpiosRef.current = 0;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => renderRef.current());
    }
  }, []);

  // Los callbacks llegan como arrow functions inline desde App, o sea con
  // identidad nueva en cada render. Guardarlos en refs evita que el efecto
  // que rasteriza los recursos se vuelva a disparar (y re-rasterice todo)
  // cada vez que el padre re-renderiza.
  const onImagesLoadedRef = useRef(onImagesLoaded);
  const onResourcesReadyRef = useRef(onResourcesReady);
  const onResourceProgressRef = useRef(onResourceProgress);
  const onRefinandoRef = useRef(onRefinando);
  const onBytesPrevistosRef = useRef(onBytesPrevistos);
  const onPrimerGestoRef = useRef(onPrimerGesto);
  const onFallidosRef = useRef(onFallidos);
  const onCoberturaListaRef = useRef(onCoberturaLista);
  const onExportNoticeRef = useRef(onExportNotice);
  useEffect(() => {
    onImagesLoadedRef.current = onImagesLoaded;
    onResourcesReadyRef.current = onResourcesReady;
    onResourceProgressRef.current = onResourceProgress;
    onRefinandoRef.current = onRefinando;
    onBytesPrevistosRef.current = onBytesPrevistos;
    onPrimerGestoRef.current = onPrimerGesto;
    onFallidosRef.current = onFallidos;
    onCoberturaListaRef.current = onCoberturaLista;
    onExportNoticeRef.current = onExportNotice;
  });

  /** Se avisa una sola vez por documento (ver `onCoberturaLista`). */
  const coberturaAvisadaRef = useRef(false);

  /** Se avisa una sola vez, en el primer gesto de verdad. */
  const avisoGestoRef = useRef(false);
  /** Los bytes previstos se calculan para la PRIMERA tanda; despues el
   * usuario ya esta usando el dibujo y lo que venga es carga incremental. */
  const bytesAvisadosRef = useRef(false);

  // Sync props to refs
  useEffect(() => {
    layerConfigsRef.current = layerConfigs;
    isolatedLayerRef.current = isolatedLayer;
    imageOpacityRef.current = imageOpacity ?? 1;
    requestRedraw();
  }, [layerConfigs, isolatedLayer, imageOpacity, requestRedraw]);

  // El tema se cambia desde la galeria; el lienzo se entera por este evento.
  useEffect(() => {
    const alCambiar = (e: Event) => {
      const nuevo = (e as CustomEvent<Tema>).detail;
      // Los colores se actualizan ACA, no solo en el efecto de `tema`: el
      // requestRedraw de abajo agenda el frame de inmediato y el efecto corre
      // despues, asi que dejarlo solo al efecto repintaba con los colores
      // VIEJOS y el lienzo se quedaba con el tema anterior.
      coloresRef.current = coloresLienzo(nuevo);
      setTema(nuevo);
      // Un gesto en curso quedo con los colores viejos: se corta.
      limpiarTransformGestoRef.current();
      gestoRef.current = false;
      requestRedraw();
    };
    window.addEventListener("concepts:tema", alCambiar);
    return () => window.removeEventListener("concepts:tema", alCambiar);
  }, [requestRedraw]);

  // Pre-calcula Path2D (en dos niveles de detalle), bounding boxes para
  // frustum culling, y el orden de dibujado por capa. El orden se resuelve
  // ACA y no en cada frame: re-ordenar decenas de miles de items 60 veces
  // por segundo era el costo dominante del pan/zoom en dibujos grandes.
  const docCache = useMemo(() => {
    if (!doc) return null;
    const items: CachedItem[] = [];

    // Trazos FUSIONADOS por (capa, color, opacidad, grosor).
    //
    // Cuando el dibujo esta alejado, el descarte por frustum no descarta nada
    // —el encuadre por defecto se elige justamente para que entre todo— asi
    // que se hacian 2863 llamadas sueltas a `ctx.stroke()`. El cruce de JS a
    // Skia cuesta unos microsegundos por llamada, que en un ARM viejo son
    // decenas de ms por redibujo. Uniendo los trazos que comparten estado en
    // un solo Path2D, ese mismo dibujo son ~20 llamadas.
    //
    // A este zoom se usa la geometria simplificada, que es la que ya se usaba
    // de lejos: la diferencia no se ve y hay varias veces menos segmentos.
    const fusionados = new Map<string, FusionTrazos>();

    doc.layers.forEach(layer => {
      layer.strokes.forEach(stroke => {
        if (stroke.points.length === 0) return;
        // El bbox ya lo calculo el parser al leer los puntos; recalcularlo aca
        // era recorrer los 58.664 puntos del documento otra vez, al abrir.
        const { minX, minY, maxX, maxY } = stroke.bbox;
        const color = stroke.color.hex;
        const globalAlpha = stroke.color.a;
        const width = stroke.width || 1.5;

        const clave = `${layer.id}|${color}|${globalAlpha}|${width}`;
        let fusion = fusionados.get(clave);
        if (!fusion) {
          fusion = {
            path: new Path2D(),
            color,
            globalAlpha,
            width,
            layerId: layer.id,
            layerIndex: layer.index,
          };
          fusionados.set(clave, fusion);
        }
        fusion.path.addPath(buildPath(stroke.points, 2.5));

        items.push({
          kind: "stroke",
          pathFull: buildPath(stroke.points, 0.25),
          minX, minY, maxX, maxY,
          color,
          globalAlpha,
          width,
          layerId: layer.id,
          layerIndex: layer.index,
        });
      });

      layer.images.forEach(img => {
        // La caja se calcula APLICANDO la matriz, esquina por esquina.
        //
        // Antes se usaba [tx, ty, tx+ancho, ty+alto], o sea la posicion cruda
        // de la traslacion mas el tamano NATIVO del recurso, ignorando escala
        // y rotacion. En estos dibujos los planos vienen rotados -90 grados y
        // escalados a ~0,15, asi que la caja calculada quedaba diez veces mas
        // grande que la real y corrida de lugar. Como esta caja es la que usa
        // el frustum culling, habia encuadres en los que un plano que SI
        // estaba en pantalla se descartaba por caer fuera de su caja
        // fantasma: el plano desaparecia al panear o al hacer zoom y volvia
        // solo al mover un poco mas. Era el bug de "se pierden las imagenes".
        const m = img.transform;
        const w = img.width || 500;
        const h = img.height || 500;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        if (m && m.length === 16) {
          const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
          for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
            const x = a * px + c * py + e;
            const y = b * px + d * py + f;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        } else {
          minX = 0; minY = 0; maxX = w; maxY = h;
        }
        items.push({
          kind: "image",
          resourceId: img.resourceId,
          transform: img.transform,
          minX, minY, maxX, maxY,
          width: img.width, height: img.height,
          layerId: layer.id,
          layerIndex: layer.index,
          isPhoto: img.isPhoto,
        });
      });

      // Texto de la herramienta de texto. La caja es aproximada (medirla de
      // verdad exige el contexto de canvas, que aca no esta); alcanza para el
      // encuadre y el descarte por frustum.
      layer.texts.forEach((t) => {
        const lineas = t.text.split(/\r?\n/);
        const m = t.transform;
        const alto = lineas.length * ALTO_LINEA_TEXTO;
        const ancho = Math.max(...lineas.map((l) => l.length)) * ALTO_LINEA_TEXTO * 0.55;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
        for (const [px, py] of [[0, 0], [ancho, 0], [0, -alto], [ancho, -alto]]) {
          const x = a * px + c * py + e;
          const y = b * px + d * py + f;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        items.push({
          kind: "text",
          lineas,
          transform: t.transform,
          minX, minY, maxX, maxY,
          color: t.color.hex.slice(0, 7),
          globalAlpha: t.color.a,
          layerId: layer.id,
          layerIndex: layer.index,
        });
      });
    });

    // Las notas (trazos) tienen que quedar SIEMPRE arriba de las fotos, sin
    // excepcion — asi lo pidio el usuario, con independencia de en que orden
    // se hayan pegado o en que capa esten. Antes se ordenaba solo por capa y,
    // dentro de una misma capa, la imagen se pegaba DESPUES del trazo en el
    // array de items, quedando dibujada encima y tapando la anotacion.
    // `compararOrdenDibujo` es la MISMA regla que usa `renderCore.ts` para
    // las miniaturas y el export de galeria — un solo lugar, para que el
    // lienzo en vivo y lo exportado no puedan divergir.
    items.sort((a, b) =>
      compararOrdenDibujo(
        { esImagen: a.kind === "image", layerIndex: a.layerIndex },
        { esImagen: b.kind === "image", layerIndex: b.layerIndex }
      )
    );
    // Los grupos (trazos fusionados) siempre se dibujan DESPUES de todas las
    // imagenes (ver el render loop), asi que alcanza con mantenerlos
    // ordenados por capa entre si.
    const grupos = [...fusionados.values()].sort((a, b) => a.layerIndex - b.layerIndex);
    return { items, grupos };
  }, [doc]);

  useEffect(() => {
    requestRedraw();
  }, [docCache, requestRedraw]);

  const visibleItem = (item: CachedItem) => {
    if (isolatedLayerRef.current && isolatedLayerRef.current !== item.layerId) return false;
    const config = layerConfigsRef.current[item.layerId];
    return !(config && !config.visible);
  };

  /**
   * Misma cuenta que `__viewerCobertura` (mas abajo, expuesta solo para
   * tests), pero como funcion reusable: "completa" cuando TODO lo que cae
   * dentro del viewport actual (y no es una chinche demasiado chica para
   * bajarse a proposito) ya tiene un bitmap dibujable. Si el documento no
   * tiene imagenes, se considera completa de entrada (nada que esperar).
   */
  const calcularCoberturaVisible = (): { completa: boolean; colocadas: number } => {
    const dc = docCacheRef.current;
    if (!dc) return { completa: false, colocadas: 0 };
    const pan = panRef.current;
    const zoom = zoomRef.current;
    const size = sizeRef.current;
    const vMinX = -pan.x / zoom;
    const vMinY = -pan.y / zoom;
    const vMaxX = (size.width - pan.x) / zoom;
    const vMaxY = (size.height - pan.y) / zoom;
    let colocadas = 0;
    let visibles = 0;
    let conBitmap = 0;
    for (const item of dc.items) {
      // Las imagenes vienen todas primero en `docCache.items`.
      if (item.kind !== "image") break;
      colocadas++;
      if (!visibleItem(item)) continue;
      if (item.maxX < vMinX || item.minX > vMaxX || item.maxY < vMinY || item.minY > vMaxY) continue;
      const ladoPx = Math.max(item.maxX - item.minX, item.maxY - item.minY) * zoom;
      if (ladoPx < LADO_MINIMO_PX) continue; // "chinche": no se baja a proposito, no cuenta
      visibles++;
      const recurso = imagesRef.current[item.resourceId];
      if (recurso && anchoUtil(recurso.img)) conBitmap++;
    }
    if (colocadas === 0) return { completa: true, colocadas: 0 };
    return { completa: visibles > 0 && visibles === conBitmap, colocadas };
  };

  /** Se llama cada vez que puede haber cambiado la cobertura (llego un
   * bitmap, o el encuadre inicial ya se aplico). Solo avisa la PRIMERA vez
   * que da completa: a partir de ahi la vista previa ya se solto y no hay
   * que seguir midiendo. */
  const revisarCoberturaLista = () => {
    if (coberturaAvisadaRef.current) return;
    const { completa } = calcularCoberturaVisible();
    if (!completa) return;
    coberturaAvisadaRef.current = true;
    onCoberturaListaRef.current?.();
  };

  // El handle se crea UNA sola vez.
  //
  // Sin array de dependencias, React re-ejecutaba esta fabrica en cada render
  // del Viewer, y adentro hay una funcion `exportDrawing` de 150 lineas que
  // captura todo el scope. Durante la carga eso pasaba ~10 veces por segundo.
  // Lo que necesita del documento lo lee de refs, que siempre estan al dia.
  const docRef = useRef(doc);
  const docCacheRef = useRef(docCache);
  // Los planos, en orden de lectura (no en el orden en que Concepts los
  // guardo). Se recalcula solo cuando cambia `docCache` (abrir un dibujo
  // nuevo), no en cada render: con decenas de planos, ordenar por fila en
  // cada frame seria trabajo tirado.
  const planosOrdenados = useMemo(
    () => (docCache ? ordenDeLectura(docCache.items.filter((i): i is CachedImage => i.kind === "image")) : []),
    [docCache]
  );
  const planosOrdenadosRef = useRef(planosOrdenados);
  useEffect(() => {
    docRef.current = doc;
    docCacheRef.current = docCache;
    planosOrdenadosRef.current = planosOrdenados;
  }, [doc, docCache, planosOrdenados]);

  useImperativeHandle(ref, () => ({
    getStats: () => ({ ...statsRef.current }),
    zoomAll: () => fitToBoundsRef.current(),
    zoomIn: () => zoomStepRef.current(1),
    zoomOut: () => zoomStepRef.current(-1),
    cantidadPlanos: () => planosOrdenadosRef.current.length,
    irAPlano: (indice: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const item = planosOrdenadosRef.current[indice];
      if (!item) return;
      const w = item.maxX - item.minX;
      const h = item.maxY - item.minY;
      if (w <= 0 || h <= 0) return;
      // Mismo margen que `computeFit` (10%), asi el plano no queda pegado al
      // borde de la pantalla.
      const padding = Math.max(w, h) * 0.1;
      let zoom = Math.min(rect.width / (w + padding * 2), rect.height / (h + padding * 2));
      zoom = Math.max(0.001, Math.min(zoom, 20));
      const cx = (item.minX + item.maxX) / 2;
      const cy = (item.minY + item.maxY) / 2;
      zoomRef.current = zoom;
      panRef.current = { x: rect.width / 2 - cx * zoom, y: rect.height / 2 - cy * zoom };
      gestoRef.current = false;
      limpiarTransformGestoRef.current();
      requestRedraw();
      pedirRefinadoRef.current();
    },
    exportDrawing: async (format: 'png' | 'jpg' | 'pdf', zoomAll: boolean = true) => {
      const doc = docRef.current;
      const docCache = docCacheRef.current;
      if (!doc || !docCache) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      if (zoomAll) {
        // Trazos E imagenes, igual que fitToBounds/computeFit: solo trazos
        // dejaba fotos afuera del export cuando estan mas extendidas que las
        // anotaciones.
        for (const item of docCache.items) {
          if (!visibleItem(item)) continue;
          if (item.minX < minX) minX = item.minX;
          if (item.minY < minY) minY = item.minY;
          if (item.maxX > maxX) maxX = item.maxX;
          if (item.maxY > maxY) maxY = item.maxY;
        }
      }

      if (zoomAll && minX === Infinity) {
        onExportNoticeRef.current?.("El lienzo está vacío u oculto.");
        return;
      }

      let exportWidth, exportHeight;
      let translateX, translateY;
      let exportZoom = 1;

      if (zoomAll) {
        const padding = 20;
        minX -= padding;
        minY -= padding;
        maxX += padding;
        maxY += padding;
        exportWidth = maxX - minX;
        exportHeight = maxY - minY;
        translateX = -minX;
        translateY = -minY;
      } else {
        exportWidth = sizeRef.current.width;
        exportHeight = sizeRef.current.height;
        translateX = panRef.current.x;
        translateY = panRef.current.y;
        exportZoom = zoomRef.current;
      }

      // Los recursos que tiene cargados la vista estan rasterizados para
      // PANTALLA (poca resolucion a proposito, para que abrir sea rapido).
      // Para el export se vuelven a rasterizar a la resolucion del papel y
      // se descartan al terminar: asi el PDF sale nitido sin que abrir el
      // dibujo cueste un giga de RAM.
      const exportScale = safeExportScale(exportWidth, exportHeight);
      if (exportFueRecortado(exportWidth, exportHeight)) {
        console.warn("Export a menor resolucion por el limite de memoria del dispositivo");
        onExportNoticeRef.current?.(
          "Se exportó a menor resolución por la memoria disponible en este dispositivo."
        );
      }
      const escalaRecursos = exportScale * exportZoom;
      const dibujado = drawnSizes(doc);
      const targets: Record<string, { width: number; height: number }> = {};
      Object.entries(dibujado).forEach(([id, size]) => {
        targets[id] = { width: size.width * escalaRecursos, height: size.height * escalaRecursos };
      });
      // Los recursos se traen DE A UNO y se sueltan enseguida.
      //
      // Antes se pedian los 94 juntos y quedaban vivos mientras ademas existia
      // el canvas de export (hasta 96 MB en gama baja) y el JPEG resultante:
      // el pico se iba muy por encima de lo que aguanta un telefono de 1 GB.
      // Filtrar los chicos no sirve — medido, a la escala del export las 96
      // colocaciones miden 24 px o mas, o sea que son contenido real del PDF.
      // Lo que hay que acotar es cuantos estan vivos a la vez.
      const proveedor = proveedorEnStreaming(doc, targets, {
        quality: 1,
        maxPixels: Math.min(40_000_000, budgets.maxExportPixels),
        maxTotalPixels: budgets.maxExportPixels,
        minSide: 256,
        timeoutMs: 60000,
        // El export pide otra resolucion que la pantalla: cachearla
        // desalojaria las versiones de pantalla, que son las que se reusan.
        sinCache: true,
      });

      try {
        const exportCanvas = document.createElement("canvas");
        exportCanvas.width = Math.round(exportWidth * exportScale);
        exportCanvas.height = Math.round(exportHeight * exportScale);
        const ctx = exportCanvas.getContext("2d");
        if (!ctx) return;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        if (format === 'jpg' || format === 'pdf') {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
        }

        ctx.save();
        ctx.scale(exportScale, exportScale);
        ctx.translate(translateX, translateY);
        ctx.scale(exportZoom, exportZoom);

        for (const item of docCache.items) {
          if (!visibleItem(item)) continue;
          const config = layerConfigsRef.current[item.layerId];
          const layerOpacity = config ? config.opacity : 1.0;

          if (item.kind === "image") {
            const recurso = await proveedor.obtener(item.resourceId);
            if (!recurso) continue;
            ctx.save();
            ctx.globalAlpha = layerOpacity * imageOpacityRef.current;
            const m = item.transform;
            if (m && m.length === 16) {
              ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
            }
            dibujarRecurso(ctx, recurso, item.width, item.height);
            ctx.restore();
          } else if (item.kind === "text") {
            dibujarTexto(ctx, {
              type: "text",
              lineas: item.lineas,
              color: item.color,
              alpha: item.globalAlpha * layerOpacity,
              transform: item.transform,
              layerIndex: item.layerIndex,
            });
          } else {
            ctx.strokeStyle = item.color;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.lineWidth = item.width;
            ctx.globalAlpha = item.globalAlpha * layerOpacity;
            ctx.stroke(item.pathFull);
          }
        }
        ctx.restore();

        if (format === 'pdf') {
          // El PDF necesita el JPEG como base64 (jsPDF.addImage lo pide asi
          // para 'JPEG'): se mantiene toDataURL solo aca, sin tocar la
          // calidad/formato ya afinados (ver comentario original: el PDF
          // tambien iba en PNG sin perdida y pesaba 170 MB de una pagina;
          // JPEG a calidad alta pesa dos ordenes de magnitud menos y se ve
          // igual).
          const dataUrl = exportCanvas.toDataURL('image/jpeg', 0.95);
          const jsPDF = (await import('jspdf')).default;
          const pdf = new jsPDF({
            orientation: exportWidth > exportHeight ? 'landscape' : 'portrait',
            unit: 'px',
            format: [exportWidth, exportHeight]
          });
          pdf.addImage(dataUrl, 'JPEG', 0, 0, exportWidth, exportHeight);
          pdf.save('export.pdf');
        } else {
          // `toBlob` en vez de `toDataURL`: para PNG/JPG (sin pasar por
          // jsPDF) no hace falta base64 en ningun lado. `toDataURL` es un
          // encode SINCRONICO que bloquea el hilo principal -- en un export
          // "Completo" de un dibujo grande el canvas puede ser de varios
          // Mpx -- y produce una string ~33% mas pesada que el binario. El
          // mismo patron que ya usan `InteractivePreview.tsx` y
          // `exportRender.ts` para esto mismo.
          const mime = format === 'png' ? 'image/png' : 'image/jpeg';
          const blob = await new Promise<Blob | null>((resolve) =>
            exportCanvas.toBlob(resolve, mime, format === 'jpg' ? 0.95 : undefined)
          );
          if (blob) {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = `export.${format}`;
            link.href = url;
            document.body.appendChild(link);
            link.click();
            link.remove();
            // Diferido, no inmediato: revocar el ObjectURL apenas despues de
            // click() es una carrera conocida en Safari/Firefox movil (la
            // descarga puede fallar o bajar truncada sin ningun error). Mismo
            // plazo que ya usa `exportRender.ts` para el mismo problema.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }
        }
        // El canvas de export puede pesar decenas de MB; en gama baja hay que
        // soltarlo ya y no esperar al GC.
        exportCanvas.width = 0;
        exportCanvas.height = 0;
      } finally {
        proveedor.liberar();
      }
    },
    obtenerImagenCompleta: async (resourceId: string) => {
      const doc = docRef.current;
      const docCache = docCacheRef.current;
      if (!doc || !docCache) return null;
      // El tamaño INTRINSECO del recurso (antes de la matriz de colocacion):
      // es el mismo `ancho`/`alto` que espera `dibujarRecurso`, y es
      // independiente de en que parte del dibujo este puesto o a que escala.
      const item = docCache.items.find((i) => i.kind === "image" && i.resourceId === resourceId);
      if (!item || item.kind !== "image") return null;
      const anchoBase = item.width || 500;
      const altoBase = item.height || 500;
      // Cuanta resolucion pedir para la vista de foto a pantalla completa.
      //
      // Antes se pedia un lado mayor fijo de 2200 px. Para una foto cuadrada
      // eso son ~4,8 Mpx, pero los planos de esta carpeta son tiras muy
      // alargadas (relacion 1:4,7): fijar el lado LARGO en 2200 deja el corto
      // en ~470 px, o sea ~1 Mpx — un octavo del presupuesto que el
      // dispositivo permite (`maxPixelsPerResource`). Por eso la foto se veia
      // borrosa apenas se le hacia un poco de zoom dentro del visor de fotos:
      // no era el zoom, era que se pedia poca resolucion de entrada.
      //
      // Ahora el objetivo se fija por AREA (los pixeles que de verdad se
      // pueden gastar) y no por el lado mayor, asi la forma del recurso no
      // cambia cuanta resolucion recibe. Se mantiene un piso (que un recurso
      // chico no quede por debajo de lo de antes) y un techo de lado para no
      // pasarse del limite de dimension de canvas del navegador.
      //
      // Una foto real (bitmap) no gana nada mas alla de su resolucion nativa
      // — eso lo resuelve `clampTarget` dentro de loadResourceImages; un PDF
      // (plano vectorial) sí aprovecha el pedido entero.
      const LADO_MINIMO_OBJETIVO = 2200;
      // Antes hardcodeado en 8000: por debajo del techo real de Chrome de
      // escritorio (16384) pero por ENCIMA del de buena parte de las GPU
      // Android y de iOS viejo (4096-8192), donde pasarse no tira error, el
      // canvas sale en blanco. `maxCanvasSide()` resuelve el limite real del
      // dispositivo (verificado, no solo por gama) una vez por sesion.
      const LADO_MAXIMO_OBJETIVO = maxCanvasSide();
      // Mismo criterio que el lienzo (ver `maxPixelsPedido`): esta vista
      // muestra UN recurso solo y a pantalla completa, asi que puede gastar
      // mas que el techo pensado para repartir entre varios. Se corta en 16
      // Mpx porque el resultado viaja como data URL dentro de un <img>.
      const objetivoPx = Math.min(budgets.maxPixelsPerResource * 2, 16_000_000);
      const areaBase = Math.max(1, anchoBase * altoBase);
      let escala = Math.sqrt(objetivoPx / areaBase);
      const ladoBase = Math.max(anchoBase, altoBase);
      // Piso: nunca peor que el lado fijo de antes.
      escala = Math.max(escala, LADO_MINIMO_OBJETIVO / ladoBase);
      // Techo: por lado (limite de canvas) y por escala (un recurso diminuto
      // no se agranda 100x para nada).
      escala = Math.min(escala, LADO_MAXIMO_OBJETIVO / ladoBase, 12);
      const w = Math.max(1, Math.round(anchoBase * escala));
      const h = Math.max(1, Math.round(altoBase * escala));

      const cargados = await loadResourceImages(doc, {
        targets: { [resourceId]: { width: w, height: h } }, // sin `region`: pagina completa, nunca recortada
        quality: 1,
        // El mismo objetivo que se acaba de calcular: si se dejara el
        // presupuesto crudo por recurso, el clamp interno podria recortar el
        // pedido justo cuando el piso de lado lo empuja por encima.
        maxPixels: Math.max(objetivoPx, w * h),
        maxTotalPixels: Math.max(objetivoPx, w * h),
        minSide: 512,
        timeoutMs: 30000,
        only: [resourceId],
        // Sin fileId: es una resolucion DISTINTA a la de pantalla (a
        // proposito, igual que el export unas lineas mas arriba) — guardarla
        // en el mismo cache persistente desalojaria las versiones de
        // pantalla, que son las que ese cache existe para servir.
      });
      const recurso = cargados[resourceId];
      if (!recurso) return null;
      try {
        // La foto se abre CON LA MISMA ORIENTACION que tiene en el dibujo.
        //
        // El bitmap del recurso esta en su espacio propio (para estos planos,
        // una tira vertical), pero el documento lo COLOCA girado: en el
        // lienzo se lee apaisado. Al abrirlo a pantalla completa se dibujaba
        // en su espacio propio, asi que aparecia de costado respecto de como
        // el usuario lo acababa de ver, y habia que enderezarlo a mano con el
        // boton de rotar cada vez.
        //
        // No se deduce un angulo con atan2: la matriz de colocacion incluye
        // la inversion de Y del documento, asi que su "angulo" no es el que
        // se ve (el primer intento salio 180 grados al reves, con la caratula
        // del plano espejada). Se reusa la matriz TAL CUAL, normalizada: se
        // le saca la escala (el tamaño ya lo fija `w`/`h`) y la traslacion (la
        // posicion dentro del dibujo no importa aca), y queda solo la parte
        // que orienta. Aplicarla antes de `dibujarRecurso` reproduce
        // exactamente lo que hace el lienzo principal, espejos incluidos.
        //
        // Cada componente se redondea a -1/0/1: las colocaciones reales son
        // cuartos de vuelta, y un angulo libre giraria la foto dejando
        // triangulos vacios en las esquinas.
        const mCol = item.transform;
        const sx = mCol && mCol.length === 16 ? Math.hypot(mCol[0], mCol[1]) : 0;
        const sy = mCol && mCol.length === 16 ? Math.hypot(mCol[4], mCol[5]) : 0;
        const base =
          mCol && sx > 0 && sy > 0
            ? {
                a: Math.round(mCol[0] / sx),
                b: Math.round(mCol[1] / sx),
                c: Math.round(mCol[4] / sy),
                d: Math.round(mCol[5] / sy),
              }
            : { a: 1, b: 0, c: 0, d: 1 };
        // Caja que ocupa la imagen ya orientada, y cuanto hay que correrla
        // para que arranque en (0,0).
        const esquinas = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => [
          base.a * x + base.c * y,
          base.b * x + base.d * y,
        ]);
        const minX = Math.min(...esquinas.map((e) => e[0]));
        const minY = Math.min(...esquinas.map((e) => e[1]));
        const maxX = Math.max(...esquinas.map((e) => e[0]));
        const maxY = Math.max(...esquinas.map((e) => e[1]));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(maxX - minX));
        canvas.height = Math.max(1, Math.round(maxY - minY));
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.setTransform(base.a, base.b, base.c, base.d, -minX, -minY);
        // Mismo helper que usan el lienzo principal y el export: deshace el
        // espejo/EXIF de las fotos y respeta el recorte si `loadResourceImages`
        // igual tuvo que darnos uno mas chico que el nativo.
        dibujarRecurso(ctx, recurso, w, h);
        // `toBlob` en vez de `toDataURL`: la foto a pantalla completa puede
        // ser de hasta varios Mpx (el techo de gama baja son 6 Mpx), y
        // `toDataURL` es un encode JPEG SINCRONICO que bloquea el hilo
        // principal, mas una string base64 (~33% mas pesada que el binario)
        // que queda viva en el estado de React mientras se mira la foto.
        // `toBlob` es async y el ObjectURL resultante es un string tan
        // usable en <img src> como un data URL, sin ninguna de las dos
        // penalidades -- a cambio de que el llamador tiene que revocarlo
        // cuando ya no lo necesite (lo hace `App.tsx`, ver `abrirFoto`).
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
        canvas.width = 0;
        canvas.height = 0;
        return blob ? URL.createObjectURL(blob) : null;
      } finally {
        liberarImagen(recurso.img);
      }
    },
    // `budgets` sale de un useMemo con dependencias vacias y `requestRedraw`
    // de un useCallback tambien con deps vacias (ver mas arriba): las dos son
    // estables toda la vida del componente, asi que el handle se sigue
    // creando una sola vez.
  }), [budgets, requestRedraw]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      sizeRef.current = { width: el.clientWidth, height: el.clientHeight };
      requestRedraw();
    };
    updateSize();
    // ResizeObserver y no solo el resize de window: el contenedor tambien
    // cambia de tamaño por layout (animacion de apertura, paneles), y ahi
    // window no dispara nada y el canvas quedaba con el tamaño viejo.
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    window.addEventListener("resize", updateSize);
    // Cambio de densidad de pantalla SIN cambio de tamaño: mover la ventana a
    // otro monitor o cambiar el zoom del navegador no toca `clientWidth`, asi
    // que ni el ResizeObserver ni el resize de window se enteran, y el canvas
    // se quedaba con el buffer de la densidad vieja (borroso, o gastando
    // pixeles de mas). El media query se re-arma en cada cambio porque
    // consulta el DPR concreto del momento.
    let mq: MediaQueryList | null = null;
    const alCambiarDpr = () => {
      requestRedraw();
      escucharDpr();
    };
    const escucharDpr = () => {
      mq?.removeEventListener("change", alCambiarDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener("change", alCambiarDpr);
    };
    escucharDpr();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateSize);
      mq?.removeEventListener("change", alCambiarDpr);
    };
  }, [requestRedraw]);

  /** Encuadre "zoom all" calculado sin tocar el estado, para poder saber de
   * antemano a que zoom se va a abrir el dibujo (y con eso decidir a que
   * resolucion rasterizar las fotos). */
  const computeFit = useCallback(() => {
    if (!docCache || !containerRef.current) return null;
    // clientWidth/clientHeight (no getBoundingClientRect): el contenedor
    // esta dentro del "hero" que anima con scale/translate al abrir el
    // dibujo, y getBoundingClientRect refleja ese tamaño visual transitorio
    // (chico, a mitad de la animacion) en vez del tamaño real de layout,
    // lo que encuadraba mal el zoom inicial.
    const rect = { width: containerRef.current.clientWidth, height: containerRef.current.clientHeight };
    if (rect.width === 0 || rect.height === 0) return null;

    // Trazos E imagenes, siempre los dos: encuadrar solo por trazos dejaba
    // fotos afuera de la vista cuando estan mas lejos/mas extendidas que las
    // anotaciones (un dibujo con varias laminas pegadas pero anotaciones
    // concentradas en una sola mostraba "zoom all" recortando el resto).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of docCache.items) {
      if (item.minX < minX) minX = item.minX;
      if (item.minY < minY) minY = item.minY;
      if (item.maxX > maxX) maxX = item.maxX;
      if (item.maxY > maxY) maxY = item.maxY;
    }
    if (minX === Infinity) return null;

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    if (!(contentWidth > 0) || !(contentHeight > 0)) return null;

    // El padding se pide en px pero se cede si el dibujo es muy ancho: en un
    // telefono de 360 px con un dibujo de 3279 unidades, 40 px por lado son el
    // 22% del ancho util.
    const pad = Math.min(40, rect.width * 0.06, rect.height * 0.06);
    let zoom = Math.min((rect.width - pad * 2) / contentWidth, (rect.height - pad * 2) / contentHeight);
    // El piso tiene que dejar entrar dibujos MUY anchos. Con 0.1 fijo, el
    // dibujo mas pesado (3279 x 2399 unidades) no entraba en 360 px de ancho y
    // "ver todo" dejaba los planos de los costados fuera de pantalla.
    zoom = Math.max(0.001, Math.min(zoom, 5));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return {
      zoom,
      pan: { x: rect.width / 2 - cx * zoom, y: rect.height / 2 - cy * zoom },
    };
  }, [docCache]);

  const fitToBounds = useCallback(() => {
    const fit = computeFit();
    if (!fit) return;
    zoomRef.current = fit.zoom;
    panRef.current = fit.pan;
    // Al reencuadrar se sale de cualquier gesto en curso, y hay que sacarle
    // el transform al lienzo: si no, el compositor seguiria mostrando los
    // pixeles viejos corridos por un gesto que ya no existe.
    gestoRef.current = false;
    limpiarTransformGestoRef.current();
    requestRedraw();
    pedirRefinadoRef.current();
    // El encuadre inicial puede ser lo que recien pone recursos YA cargados
    // dentro del viewport (p.ej. un documento con un solo plano que llego
    // antes de que se supiera donde centrar la vista): sin esto, ese caso no
    // tenia ningun otro disparador que volviera a revisar la cobertura.
    revisarCoberturaLista();
  }, [computeFit, requestRedraw]);

  // El handle imperativo se crea una sola vez; estos refs le dan acceso a la
  // version actual de las funciones sin recrearlo.
  const fitToBoundsRef = useRef(fitToBounds);
  useEffect(() => {
    fitToBoundsRef.current = fitToBounds;
  }, [fitToBounds]);

  useEffect(() => {
    fitToBounds();
  }, [docCache, fitToBounds]);

  /**
   * Ids de recursos que caen dentro de la vista, primero los que ocupan mas
   * pantalla. Es el orden en que conviene cargarlos: lo que el usuario esta
   * mirando aparece antes.
   *
   * `margen` agranda la ventana en fracciones de si misma (0.5 = medio
   * viewport de mas por lado). Sirve para adelantar lo que esta JUSTO afuera:
   * sin ese anillo, cada paneo corto descubre planos sin bitmap y el usuario
   * ve recuadros vacios hasta que terminan de rasterizarse — que es
   * exactamente el sintoma de "con el paneo se pierden las imagenes".
   */
  const recursosVisibles = useCallback((margen = 0, sinFiltroTamaño = false): string[] => {
    if (!docCache) return [];
    const pan = panRef.current;
    const zoom = zoomRef.current;
    const size = sizeRef.current;
    const mx = (size.width * margen) / zoom;
    const my = (size.height * margen) / zoom;
    const viewMinX = -pan.x / zoom - mx;
    const viewMinY = -pan.y / zoom - my;
    const viewMaxX = (size.width - pan.x) / zoom + mx;
    const viewMaxY = (size.height - pan.y) / zoom + my;

    const areas = new Map<string, number>();
    for (const item of docCache.items) {
      // `docCache.items` viene ordenado con TODAS las imagenes primero (ver
      // `compararOrdenDibujo`): en cuanto aparece algo que no es imagen, el
      // resto del array tampoco lo va a ser, asi que se corta el recorrido en
      // vez de seguir descartando trazos uno por uno. En un dibujo con miles
      // de trazos y unas pocas decenas de imagenes esto es la diferencia
      // entre recorrer decenas de items o recorrer TODO el documento — y esta
      // funcion se llama en cada sincronizacion de recursos, con CPU frenada
      // aparecia como self-time real durante los gestos.
      if (item.kind !== "image") break;
      if (!visibleItem(item)) continue;
      const ix = Math.max(0, Math.min(item.maxX, viewMaxX) - Math.max(item.minX, viewMinX));
      const iy = Math.max(0, Math.min(item.maxY, viewMaxY) - Math.max(item.minY, viewMinY));
      const area = ix * iy;
      if (area <= 0) continue;
      // Cuanto ocupa en PANTALLA. Es el criterio que decide si vale la pena
      // BAJARLO: en estos dibujos el 96% de los bytes son fotos de 3-5 MB
      // colocadas como "chinches" sobre el plano, que en el encuadre completo
      // miden 2 px de lado. Bajar 252 MB para pintar 73 puntitos de 2 px es lo
      // que hacia que abrir el dibujo mas pesado tardara mas de dos minutos.
      // Por debajo del umbral se dibuja el marcador de posicion, que a ese
      // tamano se ve igual, y la foto se trae recien cuando te acercas.
      //
      // `sinFiltroTamaño` existe para un uso DISTINTO: decidir que PROTEGER
      // de desalojo (ver `desalojarLejanos`). Un recurso que YA tiene bitmap
      // y esta en pantalla, aunque mida menos de LADO_MINIMO_PX ahora, sigue
      // siendo contenido visible -- desalojarlo por LRU lo convierte en un
      // hueco que reaparece apenas el usuario se aleja un poco. El filtro de
      // tamano solo tiene sentido para decidir que vale la pena TRAER de
      // cero, no para decidir que ya-cargado se puede tirar.
      if (!sinFiltroTamaño) {
        const ladoPx = Math.max(item.maxX - item.minX, item.maxY - item.minY) * zoom;
        if (ladoPx < LADO_MINIMO_PX) continue;
      }
      areas.set(item.resourceId, Math.max(areas.get(item.resourceId) || 0, area));
    }
    return [...areas.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [docCache]);

  // --- Recursos embebidos (fotos / PDFs) ---------------------------------
  // Esta era la causa real del freeze al abrir un dibujo pesado: cada PDF
  // embebido se rasterizaba a la escala del EXPORT (600 DPI) aunque en
  // pantalla ocupara 400x800 px, dando canvases de 50-77 megapixeles (mas de
  // 1 GB de RAM en un solo dibujo) y ademas se les hacia toDataURL() para la
  // galeria de imagenes. Ahora se rasterizan al tamaño de PANTALLA con algo
  // de margen para zoom, y se re-rasterizan solo si el usuario se acerca de
  // verdad.

  // El tamaño dibujado de cada recurso solo depende del documento, y
  // calcularlo recorre todas las capas: se hace una vez y no en cada carga.
  const dibujado = useMemo(() => (doc ? drawnSizes(doc) : {}), [doc]);

  /** A que escala (px por unidad de documento) esta rasterizado cada recurso.
   * Antes habia UN solo valor para todo el documento, que solo funciona si se
   * cargan todos los recursos juntos a la misma escala. Con la carga por
   * viewport cada recurso va por su cuenta, asi que el dato es por recurso. */
  const escalaPorRecursoRef = useRef<Record<string, number>>({});

  /**
   * Cuantas veces fallo cada recurso.
   *
   * Un recurso que no se puede traer (red caida, timeout, PDF roto) volvia a
   * la lista de pendientes en CADA gesto, con 60 s de timeout cada vez: el
   * cartel "Trayendo 1 plano…" quedaba clavado para siempre y cada arrastre
   * relanzaba un pedido condenado. Tras unos intentos se deja de insistir y se
   * marca como fallido, que ademas permite dibujarlo distinto a "todavia no
   * llego".
   */
  const fallosRef = useRef<Record<string, number>>({});
  const MAX_INTENTOS = 2;

  const pixelesDe = (r: RecursoRasterizado | undefined) =>
    r ? ((r.img as any).width || 0) * ((r.img as any).height || 0) : 0;

  /**
   * Total de pixeles de TODO lo que hay en `imagesRef.current`, llevado de
   * forma INCREMENTAL en cada alta/baja (ver los `+=`/`-=` junto a cada
   * `imagesRef.current[id] = ...` y cada `delete imagesRef.current[id]`).
   *
   * Antes esto se recalculaba escaneando el mapa entero cada vez que hacia
   * falta: en `desalojarLejanos` (que corre en CADA sync, tenga o no algo que
   * desalojar), en `recalcularPixeles` (llamada despues de cada desalojo), y
   * en `cargarRecursos` para saber cuanto presupuesto quedaba libre (hasta 3
   * veces por sync: visibles, a refinar, anillo). Con un dibujo de 96
   * recursos cargados eso eran hasta 5 recorridos completos por ciclo de
   * sincronizacion, todos calculando la MISMA suma. Medido con CPU profiling
   * bajo CPU frenada 10x: esos recorridos aparecian como self-time real
   * dentro de Viewer.tsx durante gestos, no gratis.
   */
  const pixelesTotalesRef = useRef(0);

  const recalcularPixeles = useCallback(() => {
    statsRef.current.pixelesImagenes = pixelesTotalesRef.current;
  }, []);

  /**
   * Suelta los bitmaps que hace rato que no se ven, si nos pasamos del
   * presupuesto de RAM.
   *
   * Hace falta desde que la carga es por viewport: recorrer un dibujo de 96
   * planos iria acumulando bitmaps hasta que Android mate la pestaña. Nunca se
   * desaloja algo que este en pantalla o en el anillo — soltar justo lo que se
   * esta mirando es la forma mas facil de fabricar el bug que se quiere evitar.
   */
  const desalojarLejanos = useCallback(
    (protegidos: string[]) => {
      // Los ultimos dos planos a resolucion plena tambien se protegen aca:
      // el tope de RAM del dispositivo no debe ser lo que los desaloje, ese
      // trabajo ya lo hace `marcarHot` con su propio tope fijo de 2 (ver
      // comentario en hotFifoRef). Sin esto, en un dibujo con muchos planos
      // visibles a la vez el LRU por RAM podia desalojar un "hot" antes de
      // que llegara un tercero, y entonces la cola FIFO ya no reflejaba lo
      // que de verdad seguia en memoria.
      const salvo = new Set([...protegidos, ...hotFifoRef.current]);
      let total = pixelesTotalesRef.current;
      if (total <= budgets.maxImagePixels) return;

      const candidatos = Object.keys(imagesRef.current)
        .filter((id) => !salvo.has(id))
        .sort((a, b) => (usoRef.current[a] ?? 0) - (usoRef.current[b] ?? 0));

      const siguiente = { ...imagesRef.current };
      let liberados = 0;
      for (const id of candidatos) {
        if (total <= budgets.maxImagePixels) break;
        const r = siguiente[id];
        const px = pixelesDe(r);
        total -= px;
        pixelesTotalesRef.current -= px;
        delete siguiente[id];
        delete escalaPorRecursoRef.current[id];
        // Sin esto, un recurso desalojado (bitmap liberado, ya no existe en
        // `imagesRef`) seguia con `topeAlcanzadoRef`/`plenoPedidoRef` de la
        // vez anterior: al volver a cargarlo de cero, `necesita()` podia
        // creer que ya estaba saturado sin haber pedido nada todavia.
        delete topeAlcanzadoRef.current[id];
        delete plenoPedidoRef.current[id];
        liberarImagen(r.img);
        liberados++;
      }
      if (liberados > 0) {
        imagesRef.current = siguiente;
        statsRef.current.recursosCargados = Object.keys(siguiente).length;
        recalcularPixeles();
      }
    },
    [budgets, recalcularPixeles]
  );

  /**
   * Anota un recurso como recien llegado a resolucion PLENA y hace cumplir
   * el tope de la cola (ver hotFifoRef). Estrictamente FIFO: si el recurso
   * ya estaba en la cola no se lo reordena, asi que volver a mirarlo no lo
   * "renueva" ni lo salva de salir cuando entra un tercero — eso es lo que
   * el usuario pidio (predecible: los ultimos DOS que se enfocaron, sin
   * sorpresas por reuso).
   *
   * No desaloja lo que esta actualmente en pantalla (`visibles`): sacar de
   * memoria algo que se esta mirando ahi mismo no libera nada (se vuelve a
   * pedir en la proxima sincronizacion) y solo fabricaria un parpadeo.
   */
  const marcarHot = useCallback((id: string, visibles: string[]) => {
    if (hotFifoRef.current.includes(id)) return;
    hotFifoRef.current.push(id);
    if (hotFifoRef.current.length <= MAX_HOT_FIFO) return;

    const enPantalla = new Set(visibles);
    // Busca el mas viejo que ya no este en pantalla; si todos lo estan (caso
    // raro: 3+ planos a resolucion plena a la vez en el viewport) no se
    // desaloja nada y la cola queda temporalmente mas larga que el tope.
    const idx = hotFifoRef.current.findIndex((x) => !enPantalla.has(x));
    if (idx === -1) return;
    const [viejo] = hotFifoRef.current.splice(idx, 1);
    const r = imagesRef.current[viejo];
    if (r) {
      const siguiente = { ...imagesRef.current };
      delete siguiente[viejo];
      delete escalaPorRecursoRef.current[viejo];
      delete topeAlcanzadoRef.current[viejo];
      delete plenoPedidoRef.current[viejo];
      pixelesTotalesRef.current -= pixelesDe(r);
      liberarImagen(r.img);
      imagesRef.current = siguiente;
      statsRef.current.recursosCargados = Object.keys(siguiente).length;
      recalcularPixeles();
    }
  }, [recalcularPixeles]);

  const cargarRecursos = useCallback(async (
    escala: number,
    signal?: AbortSignal,
    only?: string[],
    // El anillo (preview a media escala) NO cuenta para el tope FIFO de
    // resolucion plena: es a proposito mas chico y transitorio, y contarlo
    // desalojaria un "hot" de verdad por un adelanto que ni se esta mirando.
    hot = false,
    visiblesActuales: string[] = [],
    /** Pide el recurso a la maxima resolucion que permite el presupuesto,
     * independientemente del zoom actual (ver `cargaPlena`). */
    pleno = false
  ) => {
    if (!doc) return;
    if (Object.keys(dibujado).length === 0) return;
    // `maxPixelsPerResource` esta pensado para cuando hay MUCHOS recursos a
    // la vez (la vista general de un dibujo con 96 planos): ahi hace falta
    // repartir poco por cada uno. Pero para lo que el usuario esta MIRANDO
    // de verdad (`hot`, el mismo grupo que cuenta para el tope FIFO de
    // hotFifoRef) ese techo se queda corto enseguida en pantallas de alta
    // densidad — medido: un plano grande a solo 1.3x de zoom ya lo saturaba,
    // dejandolo pixelado para siempre por mas zoom que se pidiera despues.
    // Como el propio FIFO garantiza que como mucho hay MAX_HOT_FIFO recursos
    // en este grupo a la vez, el techo se reparte contra ese numero: cada uno
    // puede pedir el doble del techo normal, sin que la suma de los pinchados
    // se pase del presupuesto de RAM del documento.
    //
    // El reparto se hace contra los recursos que el dibujo TIENE de verdad,
    // no contra el tope del FIFO. Repartir siempre entre MAX_HOT_FIFO + 1
    // dejaba a un dibujo de UN SOLO plano con un cuarto del presupuesto y
    // el resto sin usar: se quedaba, literalmente, en la mitad de la
    // resolucion que el dispositivo aguanta. Con un plano solo en gama alta
    // eso son 32 Mpx en vez de 16.
    const competidores = Math.min(MAX_HOT_FIFO, Math.max(1, doc.resourceIds.length));
    const maxPixelsPedido = hot
      ? Math.min(
          budgets.maxPixelsPerResource * 4,
          Math.floor((budgets.maxImagePixels * FRACCION_PLENA) / competidores)
        )
      : budgets.maxPixelsPerResource;
    // SIEMPRE la pagina entera, nunca un recorte de lo que se ve.
    //
    // Antes se pedia solo el pedazo visible de cada plano, lo que daba mas
    // nitidez a zoom alto pero ataba el bitmap al ENCUADRE: cualquier gesto
    // que sacara la vista de ese pedazo obligaba a rasterizar de nuevo, y si
    // el aviso de "che, cambio el encuadre" no llegaba (recurso pinchado
    // como "hot", salto grande, sync abortado a mitad) el plano quedaba
    // dibujado a medias — el bug de "se rompio, salio cortado". Con la
    // pagina entera el bitmap no depende del encuadre: una vez cargado, ni
    // el paneo ni el zoom hacia afuera pueden invalidarlo, y lo unico que lo
    // vuelve a pedir es acercarse MAS de lo que su resolucion aguanta (y ni
    // eso, una vez que toco el techo de pixeles).
    const targets: Record<string, { width: number; height: number }> = {};
    Object.entries(dibujado).forEach(([id, size]) => {
      if (pleno) {
        // Por AREA: se reparte el techo de pixeles segun la forma del
        // recurso, en vez de escalar por el zoom del momento. Un plano en
        // tira (1:4,7) pedido "por lado" desperdiciaria la mayor parte del
        // presupuesto; pedido por area lo usa entero.
        const area = Math.max(1, size.width * size.height);
        const k = Math.sqrt(maxPixelsPedido / area);
        targets[id] = { width: size.width * k, height: size.height * k };
        plenoPedidoRef.current[id] = true;
        return;
      }
      targets[id] = { width: size.width * escala, height: size.height * escala };
    });

    const total = (only ?? doc.resourceIds).length;
    let listos = 0;

    // Pixeles que ya ocupan los recursos cargados: el presupuesto de RAM es
    // del DOCUMENTO entero, no de cada tanda, asi que la segunda tanda tiene
    // que arrancar donde quedo la primera.
    //
    // Arranca del total llevado incrementalmente (`pixelesTotalesRef`, ver su
    // comentario) y le resta SOLO los `only` que van a reemplazarse — antes
    // recorria TODO `imagesRef.current` para excluirlos, y esto se llama
    // hasta 3 veces por sincronizacion (visibles, a refinar, anillo).
    let yaUsados = pixelesTotalesRef.current;
    if (only) {
      for (const id of only) {
        const r = imagesRef.current[id];
        if (r) yaUsados -= pixelesDe(r);
      }
    }

    const nuevas = await loadResourceImages(doc, {
      targets,
      quality: RESOURCE_QUALITY,
      maxPixels: maxPixelsPedido,
      maxTotalPixels: budgets.maxImagePixels,
      pixelesYaUsados: yaUsados,
      minSide: 256,
      timeoutMs: 60000,
      concurrency: budgets.concurrency,
      signal,
      only,
      fileId: fileId || undefined,
      // Cada foto se pinta apenas esta lista. Antes no se veia NINGUNA hasta
      // que terminaba la ultima, que en un dibujo con 19 PDFs adjuntos son
      // mas de 20 segundos de lienzo a medio dibujar.
      onFallo: (id) => {
        fallosRef.current[id] = (fallosRef.current[id] ?? 0) + 1;
        const perdidos = Object.values(fallosRef.current).filter((n) => n >= MAX_INTENTOS).length;
        if (perdidos > 0) onFallidosRef.current?.(perdidos);
      },
      onEach: (id, recurso) => {
        // Un exito borra el historial de fallos: la red vuelve.
        delete fallosRef.current[id];
        if (signal?.aborted) return;
        const previa = imagesRef.current[id];
        // Se MUTA el record en vez de copiarlo: es un ref, no estado de React,
        // y copiarlo por cada recurso es O(n^2) de allocaciones a lo largo de
        // la carga.
        imagesRef.current[id] = recurso;
        pixelesTotalesRef.current += pixelesDe(recurso) - pixelesDe(previa);
        if (previa && previa.img !== recurso.img) liberarImagen(previa.img);

        // Se anota la escala que se CONSIGUIO, no la que se pidio.
        //
        // No son lo mismo: si el presupuesto de pixeles estaba casi agotado,
        // el rasterizador entrega el minimo legible; y el cache puede devolver
        // una version mas chica que la pedida. Anotando la pedida, `necesita()`
        // daba false para siempre y ese plano no se volvia a pedir NUNCA,
        // quedando borroso el resto de la sesion aunque despues se liberara
        // presupuesto al alejarse.
        const anchoDoc = dibujado[id]?.width ?? 0;
        const anchoReal = (recurso.img as any).width ?? 0;
        const altoReal = (recurso.img as any).height ?? 0;
        const fraccion = recurso.region?.w ?? 1;
        escalaPorRecursoRef.current[id] =
          anchoDoc > 0 && anchoReal > 0 ? anchoReal / (anchoDoc * fraccion) : escala * RESOURCE_QUALITY;
        // Si lo que se logro ya esta pegado al tope DURO con el que se pidio,
        // pedir mas CON ESE MISMO TECHO nunca va a mejorarlo (ver comentario
        // en topeAlcanzadoRef): se guarda el techo, con el mismo dato
        // (`anchoReal`/`altoReal`) que ya se usa para la escala lograda, nada
        // nuevo que calcular. 0 = no se saturo, se puede seguir refinando.
        topeAlcanzadoRef.current[id] = anchoReal * altoReal >= maxPixelsPedido * 0.95 ? maxPixelsPedido : 0;
        usoRef.current[id] = ++relojUsoRef.current;
        // Solo cuenta para el tope FIFO si de verdad llego a resolucion
        // "full HD": en una vista general de un dibujo con muchos planos,
        // TODOS estan "visibles" (hot=true) pero cada uno ocupa poco lado en
        // pantalla, y contarlos ahi desactivaria el tope de entrada (el
        // primer sync ya deja 19 recursos "hot"). El umbral distingue esa
        // vista general de haberse acercado a un plano en particular.
        if (hot && Math.max(anchoReal, altoReal) >= UMBRAL_HOT_LADO_PX) marcarHot(id, visiblesActuales);
        listos++;
        statsRef.current.recursosCargados = Object.keys(imagesRef.current).length;
        onResourceProgressRef.current?.(listos, total);
        requestRedraw();
        revisarCoberturaLista();
      },
    });

    if (signal?.aborted) {
      // Solo se liberan los que NO quedaron publicados en imagesRef: `onEach`
      // ya fue poniendo los listos ahi y el render los esta usando. Liberar
      // todo en bloque cerraba ImageBitmaps en uso, y dibujar un bitmap
      // cerrado tira excepcion (el lienzo quedaba en negro al abortar un
      // refinado por zoom).
      const enUso = imagesRef.current;
      const sobrantes: Record<string, RecursoRasterizado> = {};
      Object.entries(nuevas).forEach(([id, recurso]) => {
        if (enUso[id]?.img !== recurso.img) sobrantes[id] = recurso;
      });
      releaseResourceImages(sobrantes);
      return;
    }
    recalcularPixeles();
    requestRedraw();
    return nuevas;
  }, [doc, fileId, budgets, dibujado, requestRedraw, recalcularPixeles, marcarHot]);

  const cargaInicialRef = useRef<AbortController | null>(null);

  /** Previews chicas para el menu de imagenes. Se generan PEREZOSAMENTE (al
   * abrir el menu), no al terminar de cargar: es un loop de toDataURL en el
   * hilo principal que en gama baja cuesta cientos de ms y no hace falta si
   * el usuario nunca abre ese menu. */
  // Se regenera si cambio el conjunto de recursos cargados. Antes era un
  // pestillo permanente: las fotos que llegaban despues de la primera apertura
  // del menu no aparecian nunca, o sea que se pagaba la RAM de las previews
  // sin dar la funcionalidad.
  const previewsDeRef = useRef<string>("");
  const pedirPreviews = useCallback(async () => {
    if (!onImagesLoadedRef.current) return;
    const firma = Object.keys(imagesRef.current).sort().join(",");
    if (previewsDeRef.current === firma) return;
    const urls: Record<string, string> = {};
    for (const [id, recurso] of Object.entries(imagesRef.current)) {
      const fuente = recurso.img;
      // El loop cede el hilo entre imagenes (mas abajo), y en ese hueco
      // `desalojarLejanos`/`marcarHot` pueden liberar el bitmap de un
      // recurso que este loop todavia no proceso (`liberarImagen` hace
      // `ImageBitmap.close()`). Sin este chequeo -- el mismo que ya usa el
      // render loop antes de dibujar -- `drawImage` tiraba
      // `InvalidStateError` SIN try/catch: la excepcion mataba el resto del
      // loop, `onImagesLoaded` nunca se llamaba, y como `previewsDeRef` se
      // marcaba ANTES de empezar (ver mas abajo), reabrir el menu no
      // reintentaba nunca -- la galeria de imagenes quedaba vacia el resto
      // de la sesion.
      if (!anchoUtil(fuente)) continue;
      try {
        const w = (fuente as any).width || 384;
        const h = (fuente as any).height || 384;
        const k = Math.min(384 / Math.max(w, h), 1);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        const cctx = c.getContext("2d");
        if (cctx) {
          cctx.imageSmoothingQuality = budgets.smoothing;
          cctx.drawImage(fuente, 0, 0, c.width, c.height);
          urls[id] = c.toDataURL("image/jpeg", 0.85);
        }
        c.width = 0;
        c.height = 0;
      } catch {
        // Se salta este recurso (probablemente se libero mientras esperaba
        // su turno) en vez de abortar el resto de las previews.
      }
      // Cede el hilo entre imagenes para no bloquear los gestos.
      await new Promise((r) => setTimeout(r, 0));
    }
    // Se marca DESPUES de terminar, no antes: si el loop de arriba se
    // salteo recursos por estar liberados, la proxima apertura del menu
    // tiene que poder reintentarlos (para entonces puede que ya esten
    // cargados de nuevo).
    previewsDeRef.current = firma;
    onImagesLoadedRef.current?.(urls);
  }, [budgets]);

  // Al desmontar (cerrar el dibujo) se liberan los bitmaps Y se cierra el
  // documento (que suelta el archivo/las conexiones). Sin esto, abrir y
  // cerrar varios dibujos seguidos va acumulando RAM hasta que el navegador
  // empieza a andar mal.
  useEffect(() => {
    return () => {
      cargaInicialRef.current?.abort();
      releaseResourceImages(imagesRef.current);
      imagesRef.current = {};
      pixelesTotalesRef.current = 0;
      escalaPorRecursoRef.current = {};
      usoRef.current = {};
      fallosRef.current = {};
      hotFifoRef.current = [];
      plenoPedidoRef.current = {};
      topeAlcanzadoRef.current = {};
      // Los workers guardan los ultimos PDFs parseados para abaratar el
      // refinado por zoom. Al cerrar el dibujo ya no sirven, y si no se
      // sueltan se suman a la RAM del siguiente.
      soltarPdfsAbiertos();
      // Y los workers mismos se cierran si el usuario no vuelve a entrar en un
      // rato: cada uno retiene pdf.js entero.
      programarCierreWorkers();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  /**
   * Mantiene cargado lo que se ve, y SOLO lo que se ve.
   *
   * Antes el visor cargaba los recursos del documento entero: primero los
   * visibles y despues "el resto". Con los dibujos reales eso es inviable —
   * el mas pesado tiene 96 imagenes colocadas que suman 262 MB, o sea que
   * abrirlo significaba bajar el archivo completo (medido: 387 MB de red por
   * culpa del cache de bloques, 136 s hasta terminar) y repartir el
   * presupuesto de pixeles entre 94 recursos, dejando a cada plano con 128 kpx
   * ilegibles. Cargando por viewport se bajan ~10 MB y esos mismos pixeles se
   * gastan en los 4-6 planos que estas mirando.
   *
   * Resuelve tres cosas a la vez, y por eso es una sola funcion:
   *   - lo que ENTRO en pantalla y no tiene bitmap (paneo)
   *   - lo que necesita MAS resolucion (acercarse)
   *   - lo que tiene un recorte que ya no cubre lo que se ve (alejarse)
   */
  const sincronizarTimerRef = useRef<number | null>(null);
  const sincronizarAbortRef = useRef<AbortController | null>(null);
  // Se declara antes de definirla porque fitToBounds (que esta mas arriba)
  // necesita dispararla tras reencuadrar.
  const pedirRefinadoRef = useRef<() => void>(() => {});

  const sincronizarRecursos = useCallback(
    async (signal?: AbortSignal) => {
      if (!doc) return;
      const necesaria = zoomRef.current * budgets.maxDpr;
      const visibles = recursosVisibles();
      // Anillo alrededor de lo visible: se adelanta lo que esta a un paneo
      // corto de distancia para que no aparezcan recuadros vacios al mover.
      const cercanos = recursosVisibles(MARGEN_ANILLO);
      if (cercanos.length === 0) return;
      // Log de auditoria, apagado por defecto: activar con
      // `window.__viewerDebugCache = true` en la consola. Sirve para ver EN
      // VIVO por que un recurso se vuelve a pedir (o no) en cada sync.
      // Se activa con `window.__viewerDebugCache = true` en la consola o,
      // para que sobreviva a un F5 mientras se reproduce algo a mano, con
      // `?debug=cache` en la URL.
      const debugCache =
        (window as any).__viewerDebugCache === true ||
        new URLSearchParams(window.location.search).get("debug") === "cache";
      const logCache = debugCache ? (...args: unknown[]) => console.log("[cache]", ...args) : () => {};

      const necesita = (id: string) => {
        const cargada = imagesRef.current[id];
        if (!cargada) return true;
        // Un bitmap RECORTADO solo puede venir de una version anterior de la
        // app (hoy nunca se piden recortes, ver `cargarRecursos`): se cambia
        // por la pagina entera en cuanto se lo ve.
        if (cargada.region) {
          logCache("recarga: bitmap recortado viejo", id.slice(0, 8));
          return true;
        }
        // "Ya cargado, no insistir con la ESCALA": si este recurso ya pego
        // contra el techo DURO de pixeles CON EL QUE SE PIDIO, pedir mas otra
        // vez con ESE MISMO techo nunca va a mejorarlo — sin este freno, a
        // zoom muy alto (mas alla de lo que el presupuesto del dispositivo
        // permite) CADA gesto de pan o zoom volvia a intentar el rasterizado
        // completo sin lograr nada mejor, el "mini flash" del cartel
        // "Afinando...".
        //
        // Esta funcion solo se consulta para `visibles` (siempre con hot),
        // asi que el techo vigente AHORA es el mismo calculo "hot" que hace
        // `cargarRecursos`. Si el recurso se satur con un techo MENOR (p.ej.
        // llego por el anillo, hot=false, budgets.maxPixelsPerResource sin
        // multiplicar), hay margen de sobra para refinarlo con el techo hot
        // y no hay que rendirse.
        const techoAlcanzado = topeAlcanzadoRef.current[id] ?? 0;
        if (techoAlcanzado > 0) {
          const competidoresHot = Math.min(MAX_HOT_FIFO, Math.max(1, doc.resourceIds.length));
          const techoHotVigente = Math.min(
            budgets.maxPixelsPerResource * 4,
            Math.floor((budgets.maxImagePixels * FRACCION_PLENA) / competidoresHot)
          );
          if (techoAlcanzado >= techoHotVigente * 0.999) {
            logCache("tope de pixeles alcanzado (con el techo vigente), no se pide mas", id.slice(0, 8));
            return false;
          }
        }
        // Lo unico que queda como motivo para volver a rasterizar: el usuario
        // se acerco MAS de lo que aguanta la resolucion que tenemos. El paneo
        // ya no puede disparar nada, porque el bitmap es la pagina entera.
        const faltaEscala = necesaria > (escalaPorRecursoRef.current[id] ?? 0) * TOLERANCIA_ESCALA;
        if (faltaEscala) {
          logCache("recarga: escala insuficiente", id.slice(0, 8), "pedida=" + necesaria.toFixed(2), "actual=" + (escalaPorRecursoRef.current[id] ?? 0).toFixed(2));
        }
        return faltaEscala;
      };

      // Los que ni siquiera tienen bitmap van primero: un recuadro vacio
      // molesta mucho mas que un plano con menos resolucion de la ideal.
      //
      // `&& !enVueloRef.current.has(id)`: sin esto, dos sincronizaciones que
      // se solapan (la inicial, con 1 rAF de espera, y la que dispara el
      // debounce de `pedirRefinado` a los 220ms) recalculan `sinBitmap` cada
      // una POR SU CUENTA. Si la primera todavia no trajo el bitmap para un
      // recurso (un PDF puede tardar segundos), la segunda lo ve "sin
      // bitmap" otra vez y lo vuelve a pedir -- mismo recurso, dos viajes a
      // red y dos rasterizados con 2 workers ya limitados en gama baja. El
      // registro evita eso: un recurso que ya esta siendo traido por OTRA
      // sincronizacion en curso no se vuelve a encolar hasta que esa
      // termine (exito o error).
      const sinBitmap = cercanos.filter(
        (id) => !imagesRef.current[id] && (fallosRef.current[id] ?? 0) < MAX_INTENTOS && !enVueloRef.current.has(id)
      );
      // Mismo tope que sinBitmap: sin este chequeo, un recurso que ya tiene
      // bitmap pero cuyo refinado a mas resolucion sigue fallando (timeout
      // persistente, region invalida) se volvia a pedir en CADA sync
      // (~cada 220ms tras un gesto) para siempre, aunque ya estuviera
      // contado como "fallido" en otros lados de la UI.
      const aRefinar = visibles.filter(
        (id) =>
          imagesRef.current[id] &&
          necesita(id) &&
          (fallosRef.current[id] ?? 0) < MAX_INTENTOS &&
          !enVueloRef.current.has(id)
      );
      // El anillo se trae a la resolucion de pantalla, sin recorte: todavia no
      // se sabe que pedazo va a mirar el usuario y el recorte solo tiene
      // sentido para lo que ya esta en cuadro.
      /**
       * Con POCOS recursos no se carga "por tramos": una vez que hay algo en
       * pantalla, se trae el recurso ENTERO a la maxima resolucion que
       * permite el presupuesto y no se vuelve a tocar.
       *
       * Es lo que pidio el usuario ("si son menos de 2 imagenes ya debe estar
       * todo cargado"), y con pocos recursos sale gratis: el techo de RAM se
       * reparte entre MAX_HOT_FIFO, asi que si hay uno o dos en el documento
       * caben enteros. El limite es el mismo numero que gobierna el FIFO
       * caliente, para no prometer mas RAM de la que ese tope permite.
       *
       * NO se hace antes que la carga rapida de lo visible: la version plena
       * de un plano grande tarda segundos, y adelantarla retrasaria la
       * primera pintura — justo lo que se acaba de ganar.
       */
      const pocosRecursos = doc.resourceIds.length <= MAX_HOT_FIFO;
      const cargaPlena = pocosRecursos
        ? visibles.filter(
            (id) =>
              !plenoPedidoRef.current[id] &&
              (fallosRef.current[id] ?? 0) < MAX_INTENTOS &&
              !enVueloRef.current.has(id)
          )
        : [];
      const pendientes = [...sinBitmap, ...aRefinar, ...cargaPlena];
      if (debugCache) {
        logCache(
          `sync: zoom=${zoomRef.current.toFixed(2)} pan=(${panRef.current.x.toFixed(0)},${panRef.current.y.toFixed(0)})`,
          `necesaria=${necesaria.toFixed(2)}`,
          `visibles=${visibles.length} hotFifo=[${hotFifoRef.current.map((x) => x.slice(0, 8))}]`,
          `sinBitmap=[${sinBitmap.map((x) => x.slice(0, 8))}]`,
          `aRefinar=[${aRefinar.map((x) => x.slice(0, 8))}]`,
          `cargados=${Object.entries(imagesRef.current)
            .map(([id, r]) => `${id.slice(0, 8)}:${(r.img as any).width}x${(r.img as any).height}${r.region ? "(RECORTE)" : ""}@${(escalaPorRecursoRef.current[id] ?? 0).toFixed(2)}${topeAlcanzadoRef.current[id] ? "[tope]" : ""}`)
            .join(" ")}`
        );
      }

      // Marcar como recien usados y desalojar SIEMPRE, incluso sin nada nuevo
      // que traer: si no, quedarse paneando dentro de una zona ya cacheada
      // nunca libera lo que quedo lejos de un recorrido anterior, y el
      // presupuesto de RAM del dispositivo deja de cumplirse en silencio.
      for (const id of cercanos) usoRef.current[id] = ++relojUsoRef.current;
      // OJO: se protege con el conjunto SIN el filtro de tamaño minimo, no
      // con `cercanos`. `cercanos` (y `visibles`) excluyen las "chinches"
      // (recursos que miden menos de LADO_MINIMO_PX en pantalla) porque no
      // vale la pena TRAERLOS de cero a ese tamaño -- pero un recurso que YA
      // tiene bitmap cargado y sigue intersectando la pantalla, aunque ahora
      // mida menos de ese umbral (p.ej. tras alejar el zoom), sigue siendo
      // contenido VISIBLE. Pasar `cercanos` aca lo dejaba sin proteccion: el
      // LRU podia desalojarlo, y al acercarse un poco reaparecia como hueco
      // negro un plano que un momento antes se veia perfectamente.
      desalojarLejanos(recursosVisibles(MARGEN_ANILLO, true));
      if (pendientes.length === 0) return;

      // Se registran ANTES de empezar a pedir: es lo que hace que una
      // sincronizacion solapada (ver el comentario de `enVueloRef`) los vea
      // y no los vuelva a encolar.
      for (const id of pendientes) enVueloRef.current.add(id);

      // Cuantos bytes va a costar ESTA tanda de verdad. Es lo unico con lo que
      // se puede calcular un porcentaje y un tiempo restante honestos.
      if (!bytesAvisadosRef.current && sinBitmap.length > 0) {
        bytesAvisadosRef.current = true;
        const bytes = sinBitmap.reduce((n, id) => n + (doc.resourceSizes[id] || 0), 0);
        onBytesPrevistosRef.current?.(bytes);
      }

      onRefinandoRef.current?.(true, aRefinar.length, sinBitmap.length);
      // Expuesto en window (mismo patron que __viewerCajas/__viewerStats):
      // los bancos de pruebas necesitan saber cuando hay carga/rasterizado
      // real en curso para separar "gesto activo, deberia ser gratis" de
      // "asentando, aca vive el trabajo" sin adivinar por heuristica.
      (window as any).__viewerRefinando = true;
      const soloVisibles = sinBitmap.filter((id) => visibles.includes(id));
      const soloAnillo = sinBitmap.filter((id) => !visibles.includes(id));
      try {
        // El orden importa mas de lo que parece, y es todo sobre lo que el
        // usuario esta MIRANDO:
        //
        //   1. lo que esta en pantalla y no tiene nada          (hueco gris)
        //   2. lo que esta en pantalla y se ve borroso          (afinar)
        //   3. lo que esta afuera, para el proximo paneo        (anillo)
        //
        // Antes el anillo iba segundo, asi que al acercarte a un plano el
        // plano que tenias delante esperaba a que se rasterizaran otros que
        // estaban FUERA de cuadro. Con 2 workers y ~4,7 s por plano eso son
        // varios segundos mirando algo borroso mientras la CPU trabaja para
        // pixeles que no se ven.
        if (soloVisibles.length > 0) {
          await cargarRecursos(necesaria, signal, soloVisibles, true, visibles);
        }
        if (aRefinar.length > 0 && !signal?.aborted) {
          await cargarRecursos(necesaria, signal, aRefinar, true, visibles);
        }
        // Despues de lo urgente y antes del anillo: con pocos recursos el
        // anillo casi no existe (todo lo que hay ya esta en pantalla).
        if (cargaPlena.length > 0 && !signal?.aborted) {
          logCache("carga plena (pocos recursos)", cargaPlena.map((x) => x.slice(0, 8)).join(","));
          await cargarRecursos(necesaria, signal, cargaPlena, true, visibles, true);
        }
        if (soloAnillo.length > 0 && !signal?.aborted) {
          // El anillo va a MEDIA escala: es un cuarto de los pixeles. Todavia
          // no se sabe que pedazo va a mirar el usuario, y gastar resolucion
          // plena ahi le come presupuesto a los planos que si se ven. Cuando
          // el usuario panea hacia alla, `necesita()` lo ve corto de
          // resolucion y lo refina solo — que es el mecanismo que ya existe.
          // No cuenta como "hot": es un adelanto a media escala, no la
          // resolucion plena que gobierna el tope FIFO de 2.
          await cargarRecursos(necesaria * ESCALA_ANILLO, signal, soloAnillo);
        }
      } finally {
        (window as any).__viewerRefinando = false;
        if (!signal?.aborted) onRefinandoRef.current?.(false, 0, 0);
        // Exito, error o aborto: en cualquier caso esta sincronizacion ya
        // termino de intentarlo, y otra tiene que poder volver a pedirlos
        // si hiciera falta (p.ej. si esta fallo por timeout).
        for (const id of pendientes) enVueloRef.current.delete(id);
      }
    },
    [doc, budgets, cargarRecursos, recursosVisibles, desalojarLejanos]
  );

  /** Version con debounce, que es la que llaman los gestos: no tiene sentido
   * re-rasterizar en cada paso de la rueda del mouse. */
  const pedirRefinado = useCallback(() => {
    if (!doc) return;
    if (sincronizarTimerRef.current) window.clearTimeout(sincronizarTimerRef.current);
    sincronizarTimerRef.current = window.setTimeout(() => {
      sincronizarAbortRef.current?.abort();
      const abort = new AbortController();
      sincronizarAbortRef.current = abort;
      void sincronizarRecursos(abort.signal);
    }, DEBOUNCE_SINCRONIZAR);
  }, [doc, sincronizarRecursos]);

  useEffect(() => {
    pedirRefinadoRef.current = pedirRefinado;
  }, [pedirRefinado]);

  // Carga inicial: encuadrar, traer lo que entra en pantalla y avisar. Ya no
  // se carga "el resto" — lo que quede fuera de cuadro llega cuando el usuario
  // se mueva hacia ahi.
  useEffect(() => {
    if (!doc) return;
    // Si habia un cierre de workers programado (el usuario cerro otro dibujo
    // hace poco), se cancela: los vamos a necesitar ya.
    cancelarCierreWorkers();
    let cancelado = false;
    const abort = new AbortController();
    cargaInicialRef.current = abort;

    (async () => {
      // Se espera un frame para que el contenedor ya tenga tamaño y el
      // encuadre inicial sea el real (si no, se rasteriza para un zoom que
      // no es el que va a ver el usuario).
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (cancelado || abort.signal.aborted) return;
      // Cubre el caso "documento sin imagenes" (o cuyas imagenes ya estaban
      // todas en cache al primer intento): sin recursos que esperar, `onEach`
      // nunca se llama y nada mas dispara esta revision.
      revisarCoberturaLista();
      await sincronizarRecursos(abort.signal);
      if (cancelado || abort.signal.aborted) return;
      onResourcesReadyRef.current?.();
    })();

    return () => {
      cancelado = true;
      abort.abort();
    };
  }, [doc, sincronizarRecursos]);

  useEffect(() => {
    return () => {
      if (sincronizarTimerRef.current) window.clearTimeout(sincronizarTimerRef.current);
      sincronizarAbortRef.current?.abort();
      if (finGestoTimerRef.current) window.clearTimeout(finGestoTimerRef.current);
    };
  }, []);

  // --- Gestos: el compositor mueve los pixeles, no nosotros --------------
  //
  // Durante un pan/zoom NO se toca el canvas: se deja el ultimo frame como
  // esta y se lo desplaza/escala con un `transform` de CSS. El compositor del
  // navegador ya sabe hacer eso en la GPU, gratis para el hilo principal.
  //
  // Antes esto se hacia copiando el canvas a un snapshot y re-bliteandolo con
  // drawImage en cada frame. Medido en el perfil: 2376 ms de `drawImage` en
  // 11 s de gestos, o sea ~3,6 ms por frame — el 21% del tiempo, todo para
  // reproducir a mano algo que el compositor hace solo. Ademas obligaba a
  // reasignar el buffer del canvas dos veces por gesto (por el cambio de DPR)
  // y a leer el canvas vivo al empezar cada gesto.
  //
  // El resultado en pantalla es el mismo: los pixeles se estiran igual. Lo
  // que cambia es quien los estira.
  const aplicarTransformGesto = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = snapshotViewRef.current;
    const k = zoomRef.current / s.zoom;
    const dx = panRef.current.x - s.panX * k;
    const dy = panRef.current.y - s.panY * k;
    // El origen del escalado tiene que ser el (0,0) LOGICO —la esquina de la
    // ventana—, que dentro del canvas cae en el margen, no en su esquina.
    //
    // Con `0 0` se escalaba desde la esquina del canvas, que esta un margen
    // afuera, y el frame quedaba corrido en `margen * (1 - k)`. Al panear
    // (k = 1) eso es cero y no se notaba; en cuanto habia zoom, el dibujo
    // saltaba a cada paso de rueda y se acomodaba recien al redibujar. Ese
    // era el "el paneo anda bien pero el zoom anda muy mal".
    const m = margenLienzoRef.current;
    canvas.style.transformOrigin = `${m.x}px ${m.y}px`;
    canvas.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`;
  }, []);

  const limpiarTransformGesto = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas && canvas.style.transform) canvas.style.transform = "";
  }, []);
  limpiarTransformGestoRef.current = limpiarTransformGesto;

  const iniciarGesto = useCallback(() => {
    if (gestoRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return;
    // Solo se anota desde que encuadre parte el gesto. Cero pixeles copiados.
    snapshotViewRef.current = {
      panX: panRef.current.x,
      panY: panRef.current.y,
      zoom: zoomRef.current,
      dpr: statsRef.current.dpr,
    };
    gestoRef.current = true;
  }, []);

  const terminarGesto = useCallback(() => {
    if (!gestoRef.current) return;
    gestoRef.current = false;
    limpiarTransformGesto();
    requestRedraw();
    pedirRefinado();
  }, [limpiarTransformGesto, requestRedraw, pedirRefinado]);

  /** Durante un gesto se llama a esto en vez de a requestRedraw: el unico
   * trabajo por movimiento es escribir una propiedad CSS. */
  const marcarGesto = useCallback(() => {
    iniciarGesto();
    // Si el lienzo ya se corrio (o se estiro) demasiado, el frame viejo
    // desplazado deja borde vacio: se pide un dibujo real, que ademas
    // re-ancla el gesto (ver UMBRAL_REANCLAJE).
    const s = snapshotViewRef.current;
    const size = sizeRef.current;
    const k = zoomRef.current / s.zoom;
    const dx = panRef.current.x - s.panX * k;
    const dy = panRef.current.y - s.panY * k;
    if (
      Math.abs(dx) > size.width * UMBRAL_REANCLAJE ||
      Math.abs(dy) > size.height * UMBRAL_REANCLAJE ||
      k > UMBRAL_REANCLAJE_ZOOM ||
      k < 1 / UMBRAL_REANCLAJE_ZOOM
    ) {
      forzarDibujoRef.current = true;
      requestRedraw();
    }
    aplicarTransformGesto();
    // El primer movimiento real destapa el lienzo: la vista previa deja de
    // tener sentido en cuanto el usuario empieza a usar el dibujo.
    if (!avisoGestoRef.current) {
      avisoGestoRef.current = true;
      onPrimerGestoRef.current?.();
    }
    // Si el usuario frena (sin soltar), se re-dibuja nitido. 250 ms y no 120:
    // con 120 un arrastre lento con micro-pausas dispara redibujos completos
    // varias veces por gesto.
    if (finGestoTimerRef.current) window.clearTimeout(finGestoTimerRef.current);
    finGestoTimerRef.current = window.setTimeout(() => terminarGesto(), 250);
  }, [iniciarGesto, aplicarTransformGesto, terminarGesto, requestRedraw]);

  /** Un escalon de zoom entrada/salida, centrado en el medio de la pantalla
   * (no hay posicion de mouse de la que partir, a diferencia de la rueda).
   * Reusa `marcarGesto`: es exactamente el mismo camino que un tick de rueda
   * -- el refinado de recursos llega solo, 250 ms despues, por el mismo
   * debounce de `terminarGesto`. */
  const ZOOM_STEP_BOTON = 1.4;
  const zoomStep = useCallback((direccion: 1 | -1) => {
    const size = sizeRef.current;
    if (size.width === 0 || size.height === 0) return;
    const factor = Math.pow(ZOOM_STEP_BOTON, direccion);
    const centerX = size.width / 2;
    const centerY = size.height / 2;
    let newZoom = zoomRef.current * factor;
    newZoom = Math.max(0.01, Math.min(newZoom, 100));
    const k = newZoom / zoomRef.current;
    panRef.current = {
      x: centerX - (centerX - panRef.current.x) * k,
      y: centerY - (centerY - panRef.current.y) * k,
    };
    zoomRef.current = newZoom;
    marcarGesto();
  }, [marcarGesto]);

  // Mismo patron que `fitToBoundsRef`: el handle imperativo (mas arriba, se
  // crea una sola vez) necesita la version ACTUAL de `zoomStep` sin volver a
  // recrearse el resto de sus metodos.
  const zoomStepRef = useRef(zoomStep);
  useEffect(() => {
    zoomStepRef.current = zoomStep;
  }, [zoomStep]);

  // HIGH PERFORMANCE RENDER LOOP
  useEffect(() => {
    const render = () => {
      rafRef.current = null;
      const t0 = performance.now();
      let dibujo = false;

      // Durante un gesto no hay nada que dibujar: los pixeles ya estan y los
      // mueve el compositor. Redibujar seria trabajo que se descarta.
      if (isDirtyRef.current && (!gestoRef.current || forzarDibujoRef.current) && canvasRef.current && docCache) {
        const canvas = canvasRef.current;
        const ctx = contextoCanvas(canvas);
        const pan = panRef.current;
        const zoom = zoomRef.current;
        const size = sizeRef.current;

        if (ctx && size.width > 0 && size.height > 0) {
          // Un solo DPR. Antes se bajaba durante el gesto para ahorrar
          // pixeles, pero eso obligaba a reasignar el buffer del canvas al
          // entrar y al salir de CADA gesto (dos allocaciones de megabytes mas
          // dos invalidaciones de layout). Ahora el gesto no dibuja, asi que
          // no hay nada que ahorrar y si hay mucho que dejar de reasignar.
          // Se relee en cada frame (barato) en vez de usar el `maxDpr` que
          // quedo congelado al abrir la sesion: si la ventana cambia de
          // densidad —otro monitor, zoom del navegador, un panel que se
          // redimensiona— el canvas acompaña en vez de quedarse blando.
          const dpr = dprVivo();
          statsRef.current.dpr = dpr;

          // Margen dibujado fuera de cuadro (ver MARGEN_LIENZO).
          const margenX = Math.round(size.width * MARGEN_LIENZO);
          const margenY = Math.round(size.height * MARGEN_LIENZO);
          const lienzoW = size.width + margenX * 2;
          const lienzoH = size.height + margenY * 2;
          margenLienzoRef.current = { x: margenX, y: margenY };

          // Reasignar canvas.width/height reserva un buffer nuevo y es caro;
          // solo se hace cuando el tamaño cambio de verdad.
          const bw = Math.round(lienzoW * dpr);
          const bh = Math.round(lienzoH * dpr);
          if (canvasSizeRef.current.width !== bw || canvasSizeRef.current.height !== bh) {
            canvas.width = bw;
            canvas.height = bh;
            canvas.style.width = `${lienzoW}px`;
            canvas.style.height = `${lienzoH}px`;
            // Corrido para que el trozo que se ve siga siendo el viewport: lo
            // de mas queda debajo del `overflow: hidden` del contenedor.
            canvas.style.left = `${-margenX}px`;
            canvas.style.top = `${-margenY}px`;
            canvasSizeRef.current = { width: bw, height: bh };
          }

          {
          const colores = coloresRef.current;
          // El origen logico (0,0) sigue siendo la esquina del VIEWPORT, no la
          // del canvas: asi todo el resto del dibujado (pan, zoom, grilla,
          // frustum) sigue razonando en coordenadas de pantalla como antes y
          // el margen es transparente para ese codigo.
          ctx.setTransform(dpr, 0, 0, dpr, margenX * dpr, margenY * dpr);
          // Se PINTA el fondo en vez de limpiarlo: con tema oscuro un canvas
          // transparente dejaba ver el blanco del contenedor.
          ctx.fillStyle = colores.fondo;
          ctx.fillRect(-margenX, -margenY, lienzoW, lienzoH);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = budgets.smoothing;

          // Checkpoints de fase para el desglose por frame (ver ViewerStats).
          // performance.now() cuesta unos pocos microsegundos por llamada:
          // insignificante al lado del trabajo que mide, y con solo 5 por
          // frame no compite con el propio dibujado por el hilo principal.
          const tFaseInicio = performance.now();

          // Grid: se dibuja en coordenadas de PANTALLA (una sola pasada de
          // lineas rectas), no en coordenadas de documento — asi la cantidad
          // de lineas depende del tamaño de la ventana y no del zoom.
          // La grilla se pinta como un PATRON: un solo fillRect en vez de
          // hasta ~290 segmentos de linea antialiaseada por redibujo. El
          // mosaico se genera una vez por (tamaño de celda, color) y se reusa;
          // solo cambia al cambiar el zoom o el tema, no en cada frame.
          const gridSize = 50 * zoom;
          if (gridSize > 4) {
            const patron = patronGrilla(ctx, gridSize, colores.grilla);
            if (patron) {
              ctx.save();
              ctx.fillStyle = patron;
              // El patron se ancla al pan para que la grilla acompañe al
              // dibujo en vez de quedarse fija a la pantalla.
              ctx.translate(pan.x % gridSize, pan.y % gridSize);
              ctx.fillRect(
                -margenX - gridSize,
                -margenY - gridSize,
                lienzoW + gridSize * 2,
                lienzoH + gridSize * 2
              );
              ctx.restore();
            }
          }

          const tFaseGrid = performance.now();

          ctx.save();
          ctx.translate(pan.x, pan.y);
          ctx.scale(zoom, zoom);

          // Frustum: solo se dibuja lo que cae dentro de la ventana MAS el
          // margen de fuera de cuadro (si no, el margen quedaria vacio y no
          // serviria para nada durante el gesto).
          const viewMinX = (-margenX - pan.x) / zoom;
          const viewMinY = (-margenY - pan.y) / zoom;
          const viewMaxX = (size.width + margenX - pan.x) / zoom;
          const viewMaxY = (size.height + margenY - pan.y) / zoom;

          // Con el dibujo alejado se usan los trazos FUSIONADOS: a ese zoom el
          // frustum no descarta nada (el encuadre entra entero), asi que ir
          // trazo por trazo son 2863 llamadas para dibujar lo mismo que sale
          // en ~20. De cerca no conviene: ahi el descarte SI trabaja y dibujar
          // el grupo entero pintaria un monton de tinta fuera de pantalla.
          const usarFusionado = zoom < 0.75;

          let color = "";
          let alpha = -1;
          let ancho = -1;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";

          // Las notas (trazos) van SIEMPRE arriba de las fotos, sin excepcion:
          // por eso las imagenes se dibujan primero y los trazos fusionados
          // (el camino de lejos) se dejan para el final, despues del loop de
          // items. `docCache.items` ya viene ordenado imagenes-antes-que-
          // trazos (ver el sort en el useMemo de mas arriba), asi que alcanza
          // con mover el bloque de grupos fusionados de antes del loop a
          // despues.
          let itemsImagen = 0;
          let itemsTrazo = 0;
          // Marca de tiempo tomada UNA sola vez, al ver el primer trazo: como
          // `docCache.items` ya viene ordenado imagenes-antes-que-trazos, ese
          // instante es exactamente el limite entre las dos fases sin tener
          // que llamar a `performance.now()` en cada iteracion.
          let tFaseImagenes: number | null = null;
          for (const item of docCache.items) {
            // Los trazos ya se dibujaron todos juntos mas abajo.
            if (usarFusionado && item.kind === "stroke") continue;
            if (item.kind === "stroke" && tFaseImagenes === null) tFaseImagenes = performance.now();
            if (isolatedLayerRef.current && isolatedLayerRef.current !== item.layerId) continue;
            const config = layerConfigsRef.current[item.layerId];
            if (config && !config.visible) continue;
            if (item.maxX < viewMinX || item.minX > viewMaxX || item.maxY < viewMinY || item.minY > viewMaxY) {
              continue;
            }
            if (item.kind === "image") itemsImagen++;
            else itemsTrazo++;

            const layerOpacity = config ? config.opacity : 1.0;

            if (item.kind === "image") {
              const recurso = imagesRef.current[item.resourceId];
              // Un recurso liberado (canvas con width/height en 0) hace que
              // drawImage TIRE, y una excepcion aca aborta el frame entero.
              const usable = recurso && anchoUtil(recurso.img);
              ctx.save();
              ctx.globalAlpha = layerOpacity * imageOpacityRef.current;
              const m = item.transform;
              if (m && m.length === 16) {
                ctx.transform(m[0], m[1], m[4], m[5], m[12], m[13]);
              }
              if (usable) {
                dibujarRecurso(ctx, recurso!, item.width, item.height);
              } else {
                // Marcador de posicion: un recuadro solido en el lugar exacto
                // que ocupa el recurso. Sin esto, una imagen que todavia no
                // cargo (o que fallo, o que se oculto) simplemente no se
                // dibuja y el lienzo parece vacio o incompleto sin explicar
                // por que — que es justo lo que pasaba con los dibujos cuyos
                // trazos son anotaciones finas sobre los planos.
                // La escala en pantalla del recurso sale de datos que ya
                // tenemos (el zoom y la escala de su matriz), sin preguntarle
                // al contexto.
                const m2 = item.transform;
                const escalaItem =
                  m2 && m2.length === 16 ? Math.hypot(m2[0], m2[1]) * zoom : zoom;
                const fallo = (fallosRef.current[item.resourceId] ?? 0) >= MAX_INTENTOS;
                dibujarHueco(ctx, item.width || 0, item.height || 0, colores, escalaItem, fallo);
              }
              ctx.restore();
              // El save/restore invalida el estado de trazo cacheado.
              color = ""; alpha = -1; ancho = -1;
            } else if (item.kind === "text") {
              dibujarTexto(ctx, {
                type: "text",
                lineas: item.lineas,
                color: item.color,
                alpha: item.globalAlpha * layerOpacity,
                transform: item.transform,
                layerIndex: item.layerIndex,
              });
              color = ""; alpha = -1; ancho = -1;
            } else {
              // Cambiar strokeStyle/lineWidth/globalAlpha tiene costo; se
              // saltea cuando el valor no cambio respecto del item anterior.
              const a = item.globalAlpha * layerOpacity;
              if (item.color !== color) { ctx.strokeStyle = item.color; color = item.color; }
              if (a !== alpha) { ctx.globalAlpha = a; alpha = a; }
              if (item.width !== ancho) { ctx.lineWidth = item.width; ancho = item.width; }
              ctx.stroke(item.pathFull);
            }
          }

          // Se toma ACA: si no hubo NINGUN trazo (`tFaseImagenes` nunca se
          // seteo), la fase de imagenes ocupa hasta este punto igual — es la
          // unica forma consistente de medir "no habia trazos que dibujar"
          // sin ensuciar el loop con una rama para ese caso.
          const tFaseTrazos = performance.now();
          let gruposFusionados = 0;

          // Camino de lejos: los trazos fusionados se dibujan ACA, despues de
          // todas las imagenes, para que las notas queden arriba de las fotos
          // sin excepcion (antes se dibujaban primero y una foto pegada
          // encima de una capa tapaba las anotaciones de esa capa).
          if (usarFusionado) {
            for (const g of docCache.grupos) {
              if (isolatedLayerRef.current && isolatedLayerRef.current !== g.layerId) continue;
              const config = layerConfigsRef.current[g.layerId];
              if (config && !config.visible) continue;
              gruposFusionados++;
              const a = g.globalAlpha * (config ? config.opacity : 1.0);
              if (g.color !== color) { ctx.strokeStyle = g.color; color = g.color; }
              if (a !== alpha) { ctx.globalAlpha = a; alpha = a; }
              if (g.width !== ancho) { ctx.lineWidth = g.width; ancho = g.width; }
              ctx.stroke(g.path);
            }
          }
          const tFaseFin = performance.now();
          const tFaseImagenesFinal = tFaseImagenes ?? tFaseTrazos;
          statsRef.current.faseGridMs = tFaseGrid - tFaseInicio;
          statsRef.current.faseImagenesMs = tFaseImagenesFinal - tFaseGrid;
          statsRef.current.faseTrazosMs = tFaseTrazos - tFaseImagenesFinal;
          statsRef.current.faseTrazosFusionadosMs = tFaseFin - tFaseTrazos;
          statsRef.current.itemsImagenDibujados = itemsImagen;
          statsRef.current.itemsTrazoDibujados = itemsTrazo;
          statsRef.current.gruposFusionadosDibujados = gruposFusionados;
          ctx.restore();
          isDirtyRef.current = false;
          dibujo = true;
          // Este frame ya esta dibujado en la vista ACTUAL, asi que el
          // transform del gesto sobra: se limpia y el gesto se re-ancla aca.
          // Sin esto el frame recien pintado quedaria corrido por el
          // transform viejo — el mismo borde vacio que veniamos a evitar.
          if (forzarDibujoRef.current) {
            forzarDibujoRef.current = false;
            limpiarTransformGestoRef.current();
            snapshotViewRef.current = {
              panX: pan.x,
              panY: pan.y,
              zoom,
              dpr: statsRef.current.dpr,
            };
          }
          }
        }
      }

      // --- Cadencia REAL de presentacion -------------------------------
      // Se mide el hueco entre callbacks de requestAnimationFrame, no lo que
      // cuesta dibujar. Antes se calculaba `1000 / promedio(costoDeDibujar)`
      // topeado a 60, y ese numero no puede bajar aunque la pantalla se
      // congele: no ve los frames que el navegador descarta, ni el trabajo de
      // React, del GC o de IndexedDB que cae ENTRE frames. Un tiron de 200 ms
      // codificando un JPEG era literalmente invisible.
      const ahora = performance.now();
      const anterior = ultimoFrameRef.current;
      ultimoFrameRef.current = ahora;
      if (anterior > 0) {
        const delta = ahora - anterior;
        // Un delta enorme es el loop que se apago y volvio a arrancar, no un
        // tiron: contarlo ensuciaria la medida.
        if (delta < 1000) {
          const ring = frameTimesRef.current;
          ring[ringPosRef.current % ring.length] = delta;
          ringPosRef.current++;
          if (delta > 32) statsRef.current.framesLargos++;
        }
      }

      if (dibujo) {
        statsRef.current.ultimoFrameMs = ahora - t0;
        statsRef.current.framesDibujados++;
        framesLimpiosRef.current = 0;
      } else {
        framesLimpiosRef.current++;
      }

      // El loop se apaga tras unos frames sin nada que dibujar. Cualquier
      // interaccion lo vuelve a encender via requestRedraw.
      if (isDirtyRef.current || framesLimpiosRef.current < 3) {
        rafRef.current = requestAnimationFrame(render);
      } else {
        // Al apagarse se corta la serie de tiempos: si no, el hueco entre que
        // el loop se duerme y lo despierta el proximo gesto se contaria como
        // un frame larguisimo. Eso convertiria el ahorro de no dibujar —que es
        // el objetivo— en un tiron inventado de cientos de ms.
        ultimoFrameRef.current = 0;
      }
    };
    renderRef.current = render;
    requestRedraw();

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [docCache, budgets, requestRedraw]);

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  const [isRightDragging, setIsRightDragging] = useState(false);
  const [rightDragStartPos, setRightDragStartPos] = useState({ x: 0, y: 0 });
  const dragStartZoomRef = useRef(1);
  const dragStartPanRef = useRef({ x: 0, y: 0 });

  // Cache del rect del contenedor durante el arrastre: `getBoundingClientRect`
  // fuerza un layout sincronico, y pedirlo en CADA mousemove (ahora ademas a
  // la frecuencia nativa, sin el throttle implicito del dispatch de React)
  // paga ese costo docenas de veces por segundo aunque el contenedor no se
  // mueva ni cambie de tamaño durante un arrastre. Se toma una vez al
  // empezar el gesto y se reusa hasta soltar.
  const dragRectRef = useRef<DOMRect | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    dragRectRef.current = containerRef.current?.getBoundingClientRect() ?? null;
    if (e.button === 2) {
       setIsRightDragging(true);
       setRightDragStartPos({ x: e.clientX, y: e.clientY });
       dragStartZoomRef.current = zoomRef.current;
       dragStartPanRef.current = { ...panRef.current };
       iniciarGesto();
    } else if (e.button === 0) {
       setIsDragging(true);
       dragStartRef.current = { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y };
       iniciarGesto();
    }
  };

  const handleMouseMove = (e: React.MouseEvent | MouseEvent) => {
    if (isRightDragging) {
       const totalDx = e.clientX - rightDragStartPos.x;
       const totalDy = e.clientY - rightDragStartPos.y;

       const distance = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
       const sign = (totalDx - totalDy) >= 0 ? 1 : -1;
       const zoomDelta = sign * distance;
       const zoomFactor = Math.exp(zoomDelta * 0.015);
       let newZoom = dragStartZoomRef.current * zoomFactor;
       newZoom = Math.max(0.01, Math.min(newZoom, 100));

       const rect = dragRectRef.current ?? containerRef.current?.getBoundingClientRect();
       if (!rect) return;
       const centerX = rightDragStartPos.x - rect.left;
       const centerY = rightDragStartPos.y - rect.top;

       const newPanX = centerX - (centerX - dragStartPanRef.current.x) * (newZoom / dragStartZoomRef.current);
       const newPanY = centerY - (centerY - dragStartPanRef.current.y) * (newZoom / dragStartZoomRef.current);

       zoomRef.current = newZoom;
       panRef.current = { x: newPanX, y: newPanY };
       marcarGesto();

    } else if (isDragging) {
      panRef.current = {
        x: e.clientX - dragStartRef.current.x,
        y: e.clientY - dragStartRef.current.y,
      };
      marcarGesto();
    }
  };

  const handleMouseUp = (e: React.MouseEvent | MouseEvent) => {
    if (e.button === 2) setIsRightDragging(false);
    if (e.button === 0) setIsDragging(false);
    terminarGesto();
  };

  // Durante el arrastre, mousemove/mouseup se escuchan a mano sobre `window`
  // en vez de dejarlos como onMouseMove/onMouseUp de React: un arrastre tira
  // decenas de eventos por segundo, y cada uno pasado por el dispatch
  // sintetico de React (creacion de SyntheticEvent, batchedUpdates,
  // recorrido de ancestros) es puro overhead de hilo principal que el
  // profile de CPU real (bench-cpu-gesto-real.mjs) mostraba como entradas
  // propias — SyntheticBaseEvent/batchedUpdates$1/updatedAncestorInfoDev —
  // durante exactamente esta secuencia. Con listener nativo se paga una sola
  // vez el alta/baja del listener por gesto, no por movimiento. `onMouseDown`
  // se deja como handler de React (dispara 1 vez por gesto, no vale la pena).
  useEffect(() => {
    if (!isDragging && !isRightDragging) return;
    const onMove = (e: MouseEvent) => handleMouseMove(e);
    const onUp = (e: MouseEvent) => handleMouseUp(e);
    // En window y no en el contenedor: si el mouse sale del lienzo sin
    // soltar el boton (arrastre rapido hacia el borde), el gesto tiene que
    // seguir viendo el movimiento en vez de quedar "pegado".
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging, isRightDragging]);

  const handleWheel = (e: React.WheelEvent) => {
    const zoomFactor = 1.1;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = Math.pow(zoomFactor, direction);

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const centerX = e.clientX - rect.left;
    const centerY = e.clientY - rect.top;

    let newZoom = zoomRef.current * factor;
    newZoom = Math.max(0.01, Math.min(newZoom, 100));

    const newPanX = centerX - (centerX - panRef.current.x) * (newZoom / zoomRef.current);
    const newPanY = centerY - (centerY - panRef.current.y) * (newZoom / zoomRef.current);

    zoomRef.current = newZoom;
    panRef.current = { x: newPanX, y: newPanY };
    marcarGesto();
  };

  // El wheel se registra a mano como listener no pasivo: React lo adjunta
  // como pasivo y preventDefault() dentro de onWheel no hace nada, asi que
  // la rueda tambien scrolleaba la pagina detras del visor.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const bloquear = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", bloquear, { passive: false });
    return () => el.removeEventListener("wheel", bloquear);
  }, []);

  const touchDistStartRef = useRef<number | null>(null);
  // Puro conteo interno del gesto de triple-tap, no se lee en ningun JSX: va
  // en refs como el resto del estado de gestos de este archivo, para no
  // pedir un re-render en cada toque (el mismo motivo por el que pan/zoom/
  // drag viven en refs y no en useState).
  const lastTapRef = useRef(0);
  const tapCountRef = useRef(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    dragRectRef.current = containerRef.current?.getBoundingClientRect() ?? null;
    if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        const newCount = tapCountRef.current + 1;
        tapCountRef.current = newCount;
        if (newCount >= 3) {
           fitToBounds();
           tapCountRef.current = 0;
        }
      } else {
        tapCountRef.current = 1;
      }
      lastTapRef.current = now;

      setIsDragging(true);
      dragStartRef.current = { x: e.touches[0].clientX - panRef.current.x, y: e.touches[0].clientY - panRef.current.y };
      iniciarGesto();
    } else if (e.touches.length === 2) {
      setIsDragging(false);
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchDistStartRef.current = Math.sqrt(dx * dx + dy * dy);
      dragStartZoomRef.current = zoomRef.current;
      dragStartPanRef.current = { ...panRef.current };

      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      setRightDragStartPos({ x: cx, y: cy });
      iniciarGesto();
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    // Un movimiento de verdad (arrastre o pellizco) no es parte de una
    // secuencia de toques rapidos: sin esto, tocar-arrastrar-tocar-arrastrar
    // dentro de la ventana de 300 ms de `handleTouchStart` podia acumular
    // hasta 3 "toques" e interpretarse como el triple-tap que reencuadra
    // todo, en medio de un paneo normal.
    tapCountRef.current = 0;
    if (e.touches.length === 1 && isDragging) {
      panRef.current = {
        x: e.touches[0].clientX - dragStartRef.current.x,
        y: e.touches[0].clientY - dragStartRef.current.y,
      };
      marcarGesto();
    } else if (e.touches.length === 2 && touchDistStartRef.current !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDist = Math.sqrt(dx * dx + dy * dy);

      const zoomFactor = currentDist / touchDistStartRef.current;
      let newZoom = dragStartZoomRef.current * zoomFactor;
      newZoom = Math.max(0.01, Math.min(newZoom, 100));

      const rect = dragRectRef.current ?? containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const centerX = rightDragStartPos.x - rect.left;
      const centerY = rightDragStartPos.y - rect.top;

      const newPanX = centerX - (centerX - dragStartPanRef.current.x) * (newZoom / dragStartZoomRef.current);
      const newPanY = centerY - (centerY - dragStartPanRef.current.y) * (newZoom / dragStartZoomRef.current);

      zoomRef.current = newZoom;
      panRef.current = { x: newPanX, y: newPanY };
      marcarGesto();
    }
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    touchDistStartRef.current = null;
    terminarGesto();
  };

  // Expuesto para que App pueda pedir las previews al abrir el menu, y para
  // que los benchmarks puedan leer metricas del render sin instrumentar la UI.
  useEffect(() => {
    (window as any).__conceptsPedirPreviews = pedirPreviews;
    (window as any).__viewerStats = () => ({
      ...statsRef.current,
      // Se resume ACA y no en cada frame: ordenar 120 numeros 60 veces por
      // segundo seria justamente el tipo de trabajo que estamos sacando.
      ...resumirCadencia(frameTimesRef.current),
      // Cuantos trazos sueltos hay y en cuantos grupos quedaron: si los grupos
      // fueran casi tantos como los trazos, fusionar no serviria de nada.
      trazos: (docCache?.items ?? []).filter((i) => i.kind === "stroke").length,
      grupos: docCache?.grupos.length ?? 0,
      fallidos: Object.keys(fallosRef.current).filter((id) => (fallosRef.current[id] ?? 0) >= MAX_INTENTOS).length,
      recursosEnMemoria: Object.keys(imagesRef.current).length,
      ramImagenesMB: +((statsRef.current.pixelesImagenes * 4) / 1048576).toFixed(1),
      recortados: Object.values(imagesRef.current).filter((r) => r.region).length,
      cache: { ...statsCache },
      tiempos: { ...tiempos },
    });

    // Diagnostico del tope FIFO de resolucion plena (ver hotFifoRef), para
    // que los benchmarks puedan verificar el tope de 2 y el orden FIFO sin
    // instrumentar la UI.
    (window as any).__viewerHotCache = () => ({
      hotFifo: [...hotFifoRef.current],
      enMemoria: Object.keys(imagesRef.current),
    });

    // Cuantas de las imagenes que CAEN EN PANTALLA tienen de verdad un bitmap
    // dibujable. Es la medida directa de "se pierden imagenes con el zoom o el
    // paneo": si visiblesConBitmap baja despues de un gesto, se perdieron.
    (window as any).__viewerCobertura = () => {
      if (!docCache) return { visibles: 0, visiblesConBitmap: 0 };
      const pan = panRef.current;
      const zoom = zoomRef.current;
      const size = sizeRef.current;
      const vMinX = -pan.x / zoom;
      const vMinY = -pan.y / zoom;
      const vMaxX = (size.width - pan.x) / zoom;
      const vMaxY = (size.height - pan.y) / zoom;
      const enPantalla = new Set<string>();
      const conBitmap = new Set<string>();
      // "Chinches": las que caen en pantalla pero son tan chicas que no se
      // bajan a proposito. Se cuentan aparte para que no ensucien la medida
      // de "se ven todas las que se tienen que ver".
      const chinches = new Set<string>();
      let colocadas = 0;
      for (const item of docCache.items) {
        // Las imagenes vienen todas primero en `docCache.items` (ver el
        // comentario en `recursosVisibles`).
        if (item.kind !== "image") break;
        colocadas++;
        if (!visibleItem(item)) continue;
        if (item.maxX < vMinX || item.minX > vMaxX || item.maxY < vMinY || item.minY > vMaxY) continue;
        const ladoPx = Math.max(item.maxX - item.minX, item.maxY - item.minY) * zoom;
        if (ladoPx < LADO_MINIMO_PX) {
          chinches.add(item.resourceId);
          continue;
        }
        enPantalla.add(item.resourceId);
        const recurso = imagesRef.current[item.resourceId];
        if (recurso && anchoUtil(recurso.img)) conBitmap.add(item.resourceId);
      }
      return {
        colocadas,
        visibles: enPantalla.size,
        visiblesConBitmap: conBitmap.size,
        chinches: chinches.size,
        faltantes: [...enPantalla].filter((id) => !conBitmap.has(id)).map((id) => id.slice(0, 8)),
      };
    };

    // Cajas de las imagenes colocadas, en coordenadas del documento. Permite
    // que el test recorra plano por plano en vez de panear al azar.
    (window as any).__viewerCajas = () =>
      (docCache?.items ?? [])
        .filter((it): it is CachedImage => it.kind === "image")
        .map((it) => ({
          resourceId: it.resourceId,
          x0: it.minX,
          y0: it.minY,
          x1: it.maxX,
          y1: it.maxY,
          isPhoto: it.isPhoto,
          // Las cuatro esquinas REALES, ya transformadas. La caja de arriba es
          // el rectangulo que las contiene, y no alcanza para saber si un punto
          // cae sobre el plano: casi todos entran rotados, asi que medir "hay
          // papel" dentro de la caja mide tambien el aire de alrededor.
          quad: [[0, 0], [it.width, 0], [it.width, it.height], [0, it.height]].map(
            ([x, y]) => [
              it.transform[0] * x + it.transform[4] * y + it.transform[12],
              it.transform[1] * x + it.transform[5] * y + it.transform[13],
            ] as [number, number]
          ),
        }));

    (window as any).__viewerDiag = () => {
      return {
        cargadas: Object.fromEntries(
          Object.entries(imagesRef.current).map(([id, r]) => [
            id.slice(0, 8),
            { region: r.region, w: (r.img as any).width, h: (r.img as any).height, exif: r.exif },
          ])
        ),
        hot: [...hotFifoRef.current].map((x) => x.slice(0, 8)),
        // Encuadre desde el que arranco el gesto en curso y margen del ultimo
        // frame: con eso, un test puede calcular DONDE cae en pantalla un
        // punto del documento mientras el gesto lo mueve por CSS, y compararlo
        // con donde deberia caer.
        gesto: { enCurso: gestoRef.current, snapshot: { ...snapshotViewRef.current }, margen: { ...margenLienzoRef.current } },
        escala: Object.fromEntries(Object.entries(escalaPorRecursoRef.current).map(([id, v]) => [id.slice(0, 8), v])),
        tope: Object.fromEntries(Object.entries(topeAlcanzadoRef.current).map(([id, v]) => [id.slice(0, 8), v])),
      };
    };

    /**
     * Vuelca un bitmap ya cargado a escala reducida y reporta hasta donde
     * tiene contenido de verdad.
     *
     * Existe para distinguir dos cosas que en pantalla se ven igual: "el
     * visor dibuja mal" y "el bitmap que nos dieron ya viene a medias". Un
     * rasterizado que se corta (por ejemplo, un canvas mas grande de lo que
     * el backend del navegador puede pintar) no tira ningun error: devuelve
     * la imagen con el resto en blanco.
     */
    (window as any).__viewerAuditarBitmap = (id?: string) => {
      const entradas = Object.entries(imagesRef.current);
      const elegido = id ? entradas.find(([k]) => k.startsWith(id)) : entradas[0];
      if (!elegido) return null;
      const [resourceId, recurso] = elegido;
      const src = recurso.img as any;
      const W = src.width ?? 0;
      const H = src.height ?? 0;
      if (!W || !H) return { resourceId, error: "bitmap liberado" };
      const k = Math.min(320 / W, 320 / H, 1);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(W * k));
      c.height = Math.max(1, Math.round(H * k));
      const cx = c.getContext("2d", { willReadFrequently: true });
      if (!cx) return { resourceId, error: "sin contexto" };
      // Fondo magenta: distingue "pixel blanco del plano" de "el bitmap no
      // pinto nada aca" (transparente), que es justo lo que hay que separar.
      cx.fillStyle = "#ff00ff";
      cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(src, 0, 0, c.width, c.height);
      const px = cx.getImageData(0, 0, c.width, c.height).data;
      const filaPintada = (y: number) => {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (!(px[i] === 255 && px[i + 1] === 0 && px[i + 2] === 255)) return true;
        }
        return false;
      };
      let primera = -1;
      let ultima = -1;
      let vacias = 0;
      for (let y = 0; y < c.height; y++) {
        if (filaPintada(y)) {
          if (primera === -1) primera = y;
          ultima = y;
        } else vacias++;
      }
      return {
        resourceId,
        bitmap: [W, H],
        filasConContenido: [primera, ultima],
        // Que fraccion del alto del bitmap tiene contenido. Si el rasterizado
        // se corto, esto es netamente menor que 1.
        cobertura: +(((ultima - primera + 1) / c.height) || 0).toFixed(3),
        filasVacias: vacias,
        muestra: c.toDataURL("image/png"),
      };
    };

    // Leer y fijar el encuadre, para poder volver EXACTAMENTE a la misma vista
    // y comparar el lienzo contra si mismo tras un vendaval de gestos.
    (window as any).__viewerVista = () => ({
      zoom: zoomRef.current,
      panX: panRef.current.x,
      panY: panRef.current.y,
    });
    (window as any).__viewerFijarVista = (v: { zoom: number; panX: number; panY: number }) => {
      if (!v) return;
      zoomRef.current = v.zoom;
      panRef.current = { x: v.panX, y: v.panY };
      gestoRef.current = false;
      limpiarTransformGestoRef.current();
      requestRedraw();
      pedirRefinadoRef.current();
    };

    return () => {
      delete (window as any).__conceptsPedirPreviews;
      delete (window as any).__viewerStats;
      delete (window as any).__viewerHotCache;
      delete (window as any).__viewerCobertura;
      delete (window as any).__viewerCajas;
      delete (window as any).__viewerDiag;
      delete (window as any).__viewerAuditarBitmap;
      delete (window as any).__viewerVista;
      delete (window as any).__viewerFijarVista;
      delete (window as any).__viewerRefinando;
    };
  }, [pedirPreviews, docCache, requestRedraw]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        position: "relative",
        cursor: isDragging ? "grabbing" : (isRightDragging ? "ns-resize" : "grab"),
        touchAction: "none"
      }}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          // El lienzo se dibuja mas grande que la ventana y se corre hacia
          // arriba/izquierda (ver MARGEN_LIENZO), asi que va posicionado. El
          // `zIndex: 0` no es decorativo: al sacarlo del flujo, un canvas sin
          // z-index se pinta ENCIMA de los hermanos no posicionados y se
          // comia los clicks del modal de bienvenida (lo cazo el test, que se
          // quedo sin poder apretar "Continuar sin nombre").
          position: "absolute",
          zIndex: 0,
          // Los gestos los escucha el CONTENEDOR, no el canvas. Dejarlo
          // transparente a los eventos evita que, ya posicionado, le robe los
          // clicks a cualquier cosa que se muestre encima.
          pointerEvents: "none",
          touchAction: "none",
        }}
      />
      {/* Zoom Reference Indicator */}
      {isRightDragging && (
        <div style={{
          position: 'absolute',
          // `dragRectRef` ya tiene el rect cacheado desde que arranco el gesto
          // (ver `handleMouseDown`/`handleTouchStart`): reusarlo evita DOS
          // layouts sincronicos por frame durante todo el pinch/zoom con boton
          // derecho, que es exactamente cuando este indicador esta visible.
          left: rightDragStartPos.x - (dragRectRef.current?.left ?? 0),
          top: rightDragStartPos.y - (dragRectRef.current?.top ?? 0),
          width: '16px',
          height: '16px',
          marginLeft: '-8px',
          marginTop: '-8px',
          border: '2px solid red',
          borderRadius: '50%',
          pointerEvents: 'none',
          boxShadow: '0 0 4px rgba(0,0,0,0.5)',
          zIndex: 100
        }}>
          <div style={{ width: '4px', height: '4px', background: 'red', borderRadius: '50%', margin: '4px' }} />
        </div>
      )}
    </div>
  );
});

/**
 * Recuadro que ocupa el lugar de un recurso que no esta dibujado (todavia
 * cargando, fallado, u oculto). Se dibuja en el espacio YA transformado del
 * recurso, asi que hereda su rotacion y escala y queda exactamente donde ira
 * la imagen. Lleva una diagonal tenue para que se lea como "hueco" y no como
 * un rectangulo del dibujo.
 */
function dibujarHueco(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  colores: { huecoBorde: string; huecoRelleno: string },
  escalaPantalla: number,
  fallo = false
) {
  if (!(w > 0) || !(h > 0)) return;
  const escala = Math.max(escalaPantalla, 0.0001);
  // Cuanto mide en PANTALLA. Decide como se dibuja: lo que a 3 px se lee como
  // suciedad, a 300 px se lee como un marco vacio.
  const ladoPx = Math.max(w, h) * escala;

  // Muy chico: un punto de tamaño CONSTANTE en pantalla, sin caja ni
  // diagonales. Antes se pintaba un rectangulo relleno con dos diagonales —la
  // iconografia universal de "imagen rota"— y en el encuadre completo de estos
  // dibujos eso son 73 motas oscuras salpicadas sobre planos blancos. El
  // arquitecto pensaba que el escaneo salio sucio, no que ahi hay una foto.
  if (ladoPx < 16) {
    const r = 3.5 / escala;
    ctx.fillStyle = colores.huecoBorde;
    ctx.globalAlpha *= 0.75;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // De tamaño util: relleno TRANSLUCIDO (tiñe el plano en vez de taparlo) y
  // un marco fino. Sin diagonales: no es un error, es una foto que todavia no
  // se trajo.
  ctx.globalAlpha *= 0.35;
  ctx.fillStyle = colores.huecoRelleno;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha /= 0.35;

  // El grosor se compensa por la escala para que el borde se vea igual de fino
  // sin importar el zoom. La escala llega calculada: pedirsela al contexto con
  // getTransform() aloca un DOMMatrix, y durante la carga TODAS las imagenes
  // son huecos, o sea decenas de DOMMatrix por frame.
  ctx.strokeStyle = colores.huecoBorde;
  ctx.lineWidth = 1 / escala;
  ctx.globalAlpha *= 0.7;
  ctx.strokeRect(0, 0, w, h);

  // Y un glifo simple de foto en el centro, para que se entienda que falta una
  // imagen. Solo cuando hay lugar de sobra.
  if (ladoPx >= 64) {
    const lado = Math.min(w, h) * 0.28;
    const cx = w / 2;
    const cy = h / 2;
    ctx.beginPath();
    if (fallo) {
      // Se dio por perdido: una cruz, que si significa "no se pudo".
      ctx.moveTo(cx - lado / 2, cy - lado / 2);
      ctx.lineTo(cx + lado / 2, cy + lado / 2);
      ctx.moveTo(cx + lado / 2, cy - lado / 2);
      ctx.lineTo(cx - lado / 2, cy + lado / 2);
    } else {
      ctx.rect(cx - lado / 2, cy - lado / 2, lado, lado);
      // La "montaña" del icono clasico de imagen.
      ctx.moveTo(cx - lado / 2, cy + lado / 4);
      ctx.lineTo(cx - lado / 8, cy - lado / 8);
      ctx.lineTo(cx + lado / 8, cy + lado / 8);
      ctx.lineTo(cx + lado / 3, cy - lado / 6);
      ctx.lineTo(cx + lado / 2, cy + lado / 4);
    }
    ctx.stroke();
  }
}

/**
 * Resume los huecos entre frames en algo comparable entre corridas.
 *
 * Devuelve la MEDIANA (no el promedio) porque un solo tiron de 300 ms
 * arrastra el promedio y hace parecer que todo va mal, cuando lo que hay que
 * ver son dos cosas separadas: la cadencia habitual (mediana) y cuanto se
 * rompe (p95 y cantidad de frames largos).
 */
function resumirCadencia(ring: Float32Array): { fps: number; p95FrameMs: number } {
  const usados: number[] = [];
  for (const v of ring) if (v > 0) usados.push(v);
  if (usados.length < 4) return { fps: 0, p95FrameMs: 0 };
  usados.sort((a, b) => a - b);
  const mediana = usados[Math.floor(usados.length / 2)];
  const p95 = usados[Math.min(usados.length - 1, Math.floor(usados.length * 0.95))];
  return {
    fps: +(1000 / Math.max(mediana, 0.001)).toFixed(1),
    p95FrameMs: +p95.toFixed(1),
  };
}

/**
 * El Viewer no se re-renderiza si sus props no cambiaron.
 *
 * Va de la mano con estabilizar los callbacks en App: sin memo, cada aviso de
 * progreso (10 por segundo durante la carga) re-renderizaba un componente con
 * ~15 closures y el handle imperativo adentro. Con memo + callbacks estables,
 * la carga deja de pelear con los gestos por el hilo principal.
 */
export const Viewer = memo(ViewerBase);

/**
 * Mosaico de la grilla, cacheado por (tamaño de celda, color).
 *
 * Dibujar la grilla linea por linea eran hasta ~290 segmentos por redibujo;
 * con un patron es un solo `fillRect`. El mosaico se regenera solo cuando
 * cambia el zoom lo suficiente como para cambiar el tamaño de celda, o cuando
 * cambia el tema.
 */
let grillaCache: { clave: string; patron: CanvasPattern | null } | null = null;
function patronGrilla(
  ctx: CanvasRenderingContext2D,
  gridSize: number,
  color: string
): CanvasPattern | null {
  // Se redondea el lado para no regenerar el mosaico por diferencias
  // invisibles de zoom.
  const lado = Math.max(4, Math.round(gridSize));
  const clave = `${lado}|${color}`;
  if (grillaCache && grillaCache.clave === clave) return grillaCache.patron;

  const tile = document.createElement("canvas");
  tile.width = lado;
  tile.height = lado;
  const tctx = tile.getContext("2d");
  let patron: CanvasPattern | null = null;
  if (tctx) {
    tctx.strokeStyle = color;
    tctx.lineWidth = 1;
    tctx.beginPath();
    // Las lineas van en el borde del mosaico, a medio pixel, para que salgan
    // nitidas igual que con el dibujado directo.
    tctx.moveTo(0.5, 0);
    tctx.lineTo(0.5, lado);
    tctx.moveTo(0, 0.5);
    tctx.lineTo(lado, 0.5);
    tctx.stroke();
    patron = ctx.createPattern(tile, "repeat");
  }
  grillaCache = { clave, patron };
  return patron;
}

/**
 * Contexto 2D del lienzo, creado una sola vez y con `alpha: false`.
 *
 * El canvas nunca es transparente (siempre se pinta el fondo del tema), asi
 * que declararlo opaco le permite al compositor saltear el mezclado de toda
 * la capa — que en un movil de gama baja es trabajo por frame presentado.
 * Los atributos solo se pueden pasar en la PRIMERA llamada a getContext, por
 * eso hace falta guardarlo en vez de pedirlo en cada frame.
 */
const contextos = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D | null>();
function contextoCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  let ctx = contextos.get(canvas);
  if (ctx === undefined) {
    ctx = canvas.getContext("2d", { alpha: false });
    contextos.set(canvas, ctx);
  }
  return ctx;
}

/** true si la fuente tiene pixeles para dibujar. Un ImageBitmap cerrado o un
 * canvas puesto en 0x0 (que es como se libera memoria en iOS/Android) hacen
 * que drawImage lance InvalidStateError. */
function anchoUtil(img: CanvasImageSource): boolean {
  const w = (img as any).width;
  const h = (img as any).height;
  return typeof w !== "number" || (w > 0 && h > 0);
}

