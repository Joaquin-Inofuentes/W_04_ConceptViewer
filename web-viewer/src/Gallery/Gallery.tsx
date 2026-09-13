import { useEffect, useRef, useState, useCallback, useMemo, memo } from "react";
import { AnimatePresence, m } from "motion/react";
import {
  Upload, RefreshCw, AlertTriangle, CheckCircle2, Circle, Download, X,
  FileText, Image as ImageIcon, FolderOpen, Folder, Home, ChevronLeft, ChevronRight,
  Sun, Moon, Trash2, Clock,
} from "lucide-react";
import { listDriveFolder, driveFileUrl, driveAuthHeaders } from "./driveClient";
import type { DriveFolderRef, DriveListing } from "./driveClient";
import { fetchCachedThumbnails, upsertThumbnail, fetchAllFolderCache, upsertFolderCache } from "./supabaseClient";
import type { FolderCacheRow, ThumbnailRow } from "./supabaseClient";
import { thumbnailDeArchivo } from "./thumbnail";
import { renderDocumentEntry, exportSectionsAsPdf, exportSectionsAsZip } from "./exportRender";
import type { ExportSection } from "./exportRender";
import { gatherExportMetadata } from "./exportMetadata";
import { logAbrir, logDescarga } from "./analytics";
import { openConceptsRemote, parseConceptsRemote } from "../VisorConcept/parser";
import { DRIVE_FOLDER_ID } from "../config";
import { aSlug } from "../rutas";
import { alternarTema, temaGuardado } from "../theme";
import type { Tema } from "../theme";
import { listarRecientes, vaciarRecientes } from "./recientes";
import type { Reciente } from "./recientes";
import { vaciarCache, invalidarSiCambio } from "./rasterCache";
import { getBudgets } from "../device";
import { fase } from "../lib/centinela";
import "./Gallery.css";

type ItemStatus = "queued" | "processing" | "ready" | "error";

interface GalleryItem {
  id: string;
  name: string;
  thumbnail: string | null;
  status: ItemStatus;
  fromCache: boolean;
  modifiedAt: string | null;
  hasTime: boolean;
  error?: string;
}

interface FolderCrumb {
  id: string;
  name: string;
}

interface SelectedRef {
  kind: "file" | "folder";
  id: string;
  name: string;
}

interface GalleryProps {
  hidden: boolean;
  userName: string | null;
  /** `ruta` son los nombres de las carpetas contenedoras (sin la raiz): sirve
   * para armar la URL compartible y la lista de recientes. */
  onOpen: (fileId: string, name: string, originRect: DOMRect | null, ruta: string[]) => void;
  onUpload: (file: File, name: string) => void;
  /** Carpetas (por slug) a las que hay que navegar al arrancar, tomadas de la
   * URL. La galeria las resuelve contra el arbol de Drive. */
  rutaInicial?: string[];
  /** Avisa la ruta actual para que App actualice la URL. */
  onRutaCambio?: (ruta: string[]) => void;
  /** Avisa que la galeria ya pinto su primera carpeta (con o sin error): es
   * el momento "listo" del centinela para este modulo. Se llama una sola
   * vez, no en cada refresh ni al navegar entre carpetas. */
  onListo?: () => void;
}

const EASE_IOS: [number, number, number, number] = [0.16, 1, 0.3, 1];
const ROOT_CRUMB: FolderCrumb = { id: DRIVE_FOLDER_ID, name: "Inicio" };

function cleanName(name: string) {
  return name.replace(/\s+/g, " ").trim().replace(/\.concepts$/i, "");
}

function formatModified(modifiedAt: string | null, hasTime: boolean): string {
  if (!modifiedAt) return "";
  const d = new Date(modifiedAt);
  // Las fechas sin hora se guardan como medianoche UTC (el dia exacto que
  // informa Drive); leer los componentes en UTC evita que se corra un dia
  // hacia atras para usuarios en UTC negativo. Los timestamps con hora real
  // si son un instante concreto y deben mostrarse en la zona del usuario.
  const day = String(hasTime ? d.getDate() : d.getUTCDate()).padStart(2, "0");
  const month = String((hasTime ? d.getMonth() : d.getUTCMonth()) + 1).padStart(2, "0");
  const datePart = `${day}/${month}`;
  if (!hasTime) return datePart;
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${datePart} ${hours}:${minutes}hs`;
}

interface TarjetaArchivoProps {
  item: GalleryItem;
  idx: number;
  checked: boolean;
  onActivate: (item: GalleryItem, el: HTMLElement) => void;
  onToggleCheck: (e: React.MouseEvent, ref: SelectedRef) => void;
}

/**
 * Extraida de `items.map(...)` y envuelta en `React.memo`.
 *
 * `processItem` hace DOS `setItems` por archivo (`Gallery.tsx`, mas abajo):
 * con 40 archivos son 80 re-renders del componente `Gallery` completo, y sin
 * esto cada uno volvia a reconciliar las ~40 tarjetas enteras (incluidos los
 * iconos de lucide-react, que son componentes React reales, no strings). El
 * `setItems` que dispara esto usa `prev.map(it => it.id === file.id ? {...it,
 * ...} : it)`: los items NO tocados conservan la MISMA referencia de objeto,
 * asi que memo puede saltarselos de verdad -- de los 40 renders solo se
 * reconcilia el que efectivamente cambio.
 */
const TarjetaArchivo = memo(function TarjetaArchivo({
  item, idx, checked, onActivate, onToggleCheck,
}: TarjetaArchivoProps) {
  return (
    <div
      className={`gallery-card ${checked ? "selected" : ""}`}
      style={{ animationDelay: `${Math.min(idx, 12) * 35}ms` }}
      role="button"
      tabIndex={0}
      onClick={(e) => onActivate(item, e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate(item, e.currentTarget);
        }
      }}
      title={item.name}
    >
      <button
        type="button"
        className={`gallery-checkbox ${checked ? "checked" : ""}`}
        onClick={(e) => onToggleCheck(e, { kind: "file", id: item.id, name: item.name })}
        role="checkbox"
        aria-checked={checked}
        aria-label={checked ? "Deseleccionar" : "Seleccionar"}
      >
        {checked ? <CheckCircle2 size={20} /> : <Circle size={20} />}
      </button>

      <div className="gallery-thumb">
        {item.status === "ready" && item.thumbnail ? (
          // decoding="async": son data URLs (ya en memoria, sin red de por
          // medio), pero decodificar un JPEG de hasta 384px sigue siendo
          // trabajo de layout si el navegador lo hace sync. alt="": el
          // nombre del archivo ya esta en `.gallery-name` justo debajo; con
          // alt={item.name} un lector de pantalla lo anunciaba dos veces
          // seguidas.
          <img src={item.thumbnail} alt="" decoding="async" />
        ) : item.status === "error" ? (
          <div className="gallery-thumb-error">
            <AlertTriangle size={18} />
          </div>
        ) : (
          <div className="skeleton-shimmer" />
        )}
        {item.status === "processing" && (
          <div className="gallery-thumb-overlay">
            <RefreshCw size={16} className="spin-slow" />
          </div>
        )}
      </div>
      <div className="gallery-name">{item.name}</div>
      {item.modifiedAt && (
        <div className="gallery-date">{formatModified(item.modifiedAt, item.hasTime)}</div>
      )}
      {item.status === "error" && <div className="gallery-card-error">{item.error}</div>}
    </div>
  );
});

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let idx = 0;
  async function next(): Promise<void> {
    const current = idx++;
    if (current >= items.length) return;
    await worker(items[current]);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
}

export function Gallery({ hidden, userName, onOpen, onUpload, rutaInicial, onRutaCambio, onListo }: GalleryProps) {
  const [tema, setTema] = useState<Tema>(() => temaGuardado());
  const [recientes, setRecientes] = useState<Reciente[]>([]);
  const [confirmarReset, setConfirmarReset] = useState(false);
  const [folderStack, setFolderStack] = useState<FolderCrumb[]>([ROOT_CRUMB]);
  const [folders, setFolders] = useState<DriveFolderRef[]>([]);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Ya no hay estado de "abriendo": la apertura es inmediata (no se baja
  // nada aca) y el progreso real de carga lo muestra el visor, que es donde
  // ocurre.
  const [toast, setToast] = useState<string | null>(null);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Map<string, SelectedRef>>(new Map());
  const [showFormatPicker, setShowFormatPicker] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);

  const currentFolder = folderStack[folderStack.length - 1];

  // Ya no hay cache de buffers: los archivos NO se bajan enteros. Tanto la
  // miniatura como la apertura leen por rangos HTTP solo lo que necesitan
  // (110 KB y ~1 MB respectivamente, contra 262 MB del archivo mas pesado),
  // asi que no hay nada grande que valga la pena retener en memoria.
  const itemsRef = useRef<GalleryItem[]>([]);
  const foldersRef = useRef<DriveFolderRef[]>([]);
  /**
   * Ultima ruta que se resolvio, para no volver a resolver la MISMA (que
   * seria re-listar la carpeta en cada render) pero si una nueva.
   *
   * Antes era un simple "ya cargue una vez", y eso dejaba el historial a
   * medias: al apretar atras, `App` pasa la ruta nueva por esta misma via, y
   * el guard la descartaba — la URL volvia al dibujo pero la galeria se
   * quedaba donde estaba.
   */
  const rutaResueltaRef = useRef<string | null>(null);
  /** El centinela ya recibio `fase('lista')`/`listo()` para esta sesion: la
   * primera carpeta (con o sin error) alcanza, no hace falta repetirlo en
   * cada refresh ni al navegar a otra carpeta. */
  const arranqueAvisadoRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  // Arbol de carpetas ya visitadas/crawleadas (solo ids/nombres), traido
  // entero de Supabase una vez al montar. Mientras una carpeta este aca,
  // entrar/salir de ella es instantaneo: no hace falta pegarle a Drive.
  const folderTreeCacheRef = useRef<Map<string, FolderCacheRow>>(new Map());
  const folderTreeLoadedRef = useRef(false);
  /**
   * Miniaturas ya traidas de Supabase en esta sesion, por id de archivo.
   *
   * Antes `loadFolder` pegaba a Supabase por las miniaturas CADA vez que se
   * entraba a una carpeta, aunque el listado (`folderTreeCacheRef`, arriba)
   * ya estuviera cacheado y la carpeta se hubiera visitado hace un segundo
   * -- volver "atras" y "adelante" en el arbol bajaba la misma data una y
   * otra vez. Se guarda aca la fila entera (incluye `source_modified_at`,
   * que es lo que despues decide si la miniatura sigue siendo valida), asi
   * que el chequeo de "el archivo cambio desde que se genero la miniatura"
   * de mas abajo sigue funcionando igual este dato venga de red o de aca.
   */
  const thumbnailCacheRef = useRef<Map<string, ThumbnailRow>>(new Map());

  // Cerrar los modales dismissibles con Escape. `exportProgress` queda afuera
  // a proposito: no tiene boton de cancelar (la descarga ya esta en curso),
  // asi que Escape ahi no tendria nada que hacer.
  useEffect(() => {
    if (!showFormatPicker && !confirmarReset) return;
    const alEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setShowFormatPicker(false);
      setConfirmarReset(false);
    };
    document.addEventListener("keydown", alEscape);
    return () => document.removeEventListener("keydown", alEscape);
  }, [showFormatPicker, confirmarReset]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  };

  const processItem = useCallback(async (file: { id: string; name: string; modifiedAt: string | null }) => {
    setItems((prev) =>
      prev.map((it) => (it.id === file.id ? { ...it, status: "processing", error: undefined } : it))
    );
    try {
      // Camino rapido: usar la vista previa que Concepts ya dejo adentro del
      // archivo, leida POR RANGOS. Redibujar el documento desde cero cuesta
      // segundos (cada PDF embebido tarda ~1,5 s en pdf.js aunque la salida
      // sea de 32 px) y ademas obligaba a bajar el archivo entero: 262 MB
      // para producir una imagen de 192 px. Ahora son ~110 KB.
      const archivo = await openConceptsRemote(driveFileUrl(file.id), driveAuthHeaders());
      let thumbnail: string;
      let bytesFuente: number;
      try {
        ({ dataUrl: thumbnail, bytesFuente } = await thumbnailDeArchivo(archivo));
      } finally {
        archivo.close();
      }
      setItems((prev) =>
        prev.map((it) =>
          it.id === file.id ? { ...it, thumbnail, status: "ready", fromCache: false } : it
        )
      );
      await upsertThumbnail({
        drive_file_id: file.id,
        file_name: file.name,
        thumbnail_base64: thumbnail,
        source_size_bytes: bytesFuente,
        source_modified_at: file.modifiedAt,
      });
    } catch (err: any) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === file.id
            ? { ...it, status: "error", error: err?.message || "Error al procesar" }
            : it
        )
      );
    }
  }, []);

  // Carga (o refresca) el listado de una carpeta puntual: subcarpetas +
  // archivos, cruzando con el cache de Supabase para mostrar miniaturas ya
  // generadas al instante y solo procesar las que faltan. En un refresh no
  // se limpia la grilla antes de tener la respuesta nueva, para no hacer
  // parpadear lo que ya estaba mostrandose; si el listado nuevo es
  // identico al anterior (mismos ids de carpetas y archivos) se avisa con
  // un cartelito en vez de re-renderizar todo en silencio.
  //
  // El listado en si (subcarpetas + archivos, solo nombres) primero se
  // busca en el arbol cacheado de Supabase: si ya esta ahi, se muestra al
  // instante sin pegarle a Drive. Solo se pega a Drive en vivo si la
  // carpeta nunca se cacheo, o si es un refresh explicito — y en ese caso
  // el resultado se vuelve a cachear para la proxima.
  const loadFolder = useCallback(
    async (folderId: string, folderName: string, opts: { isRefresh?: boolean } = {}) => {
      const isRefresh = !!opts.isRefresh;
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setListLoading(true);
        setItems([]);
        setFolders([]);
      }
      setListError(null);
      try {
        const cached = !isRefresh ? folderTreeCacheRef.current.get(folderId) : undefined;
        let listing: DriveListing;
        if (cached) {
          listing = { folders: cached.subfolders, files: cached.files };
        } else {
          listing = await listDriveFolder(folderId);
          folderTreeCacheRef.current.set(folderId, {
            folder_id: folderId,
            name: folderName,
            subfolders: listing.folders,
            files: listing.files,
            updated_at: new Date().toISOString(),
          });
          void upsertFolderCache(folderId, folderName, listing.folders, listing.files);
        }

        // La respuesta de `action=list` de la raiz (cacheada o en vivo, las
        // dos son "la lista ya llego"): solo en la carga inicial, no en cada
        // refresh ni al entrar/salir de subcarpetas.
        if (!isRefresh && !arranqueAvisadoRef.current) fase("lista");

        if (isRefresh) {
          const prevFolderIds = new Set(foldersRef.current.map((f) => f.id));
          const newFolderIds = new Set(listing.folders.map((f) => f.id));
          const prevFileIds = new Set(itemsRef.current.map((it) => it.id));
          const newFileIds = new Set(listing.files.map((f) => f.id));
          const sameFolders =
            prevFolderIds.size === newFolderIds.size && [...prevFolderIds].every((id) => newFolderIds.has(id));
          const sameFiles =
            prevFileIds.size === newFileIds.size && [...prevFileIds].every((id) => newFileIds.has(id));
          if (sameFolders && sameFiles) {
            showToast("No se encontraron cambios");
          }
        }

        setFolders(listing.folders);

        // Solo se pide a Supabase lo que todavia no esta en el cache de esta
        // sesion. Con una carpeta ya visitada (volver atras, o el refresh
        // periodico), eso es normalmente CERO ids -- cero requests.
        const idsFaltantes = listing.files.map((f) => f.id).filter((id) => !thumbnailCacheRef.current.has(id));
        if (idsFaltantes.length > 0) {
          const traidas = await fetchCachedThumbnails(idsFaltantes);
          traidas.forEach((row, id) => thumbnailCacheRef.current.set(id, row));
        }
        const cache = thumbnailCacheRef.current;
        const prevById = new Map(itemsRef.current.map((it) => [it.id, it]));

        const nextItems: GalleryItem[] = listing.files.map((f) => {
          const cached = cache.get(f.id);
          // Si la miniatura cacheada se genero para un modifiedAt distinto al
          // actual, el archivo se re-subio con otro contenido y esa miniatura
          // ya no representa lo que hay: se descarta para que se regenere,
          // en vez de mostrarla para siempre (filas viejas sin este dato
          // guardado no se tocan: cached.source_modified_at da null y se usa
          // igual que antes).
          const cachedEstaVieja =
            !!cached?.source_modified_at && cached.source_modified_at !== f.modifiedAt;
          if (cached && !cachedEstaVieja) {
            return {
              id: f.id,
              name: cleanName(f.name),
              thumbnail: cached.thumbnail_base64,
              status: "ready",
              fromCache: true,
              modifiedAt: f.modifiedAt,
              hasTime: f.hasTime,
            };
          }
          // Si la cacheada esta vieja, tampoco sirve lo que ya se estaba
          // mostrando en pantalla (es la misma miniatura vieja): hay que
          // encolarlo para regenerar, no reusar `existing`.
          const existing = cachedEstaVieja ? undefined : prevById.get(f.id);
          if (existing && existing.status === "ready" && existing.thumbnail) {
            return { ...existing, name: cleanName(f.name), modifiedAt: f.modifiedAt, hasTime: f.hasTime };
          }
          return {
            id: f.id,
            name: cleanName(f.name),
            thumbnail: null,
            status: "queued" as ItemStatus,
            fromCache: false,
            modifiedAt: f.modifiedAt,
            hasTime: f.hasTime,
          };
        });

        setItems(nextItems);
        if (!isRefresh) setListLoading(false);

        const pending = listing.files.filter((f) => nextItems.find((it) => it.id === f.id)?.status === "queued");
        if (pending.length > 0) {
          // Antes 3 fijo, ignorando el dispositivo: en gama baja
          // `getBudgets().concurrency` es 2, y cada slot de `processItem`
          // abre su propio `RemoteSource` con cache de bloques de hasta
          // varios MB -- con 3 en paralelo eso son varios MB extra de
          // buffers de red sumados a lo que ya gasta el visor si esta
          // abierto detras.
          await runPool(pending, getBudgets().concurrency, processItem);
        }
      } catch (err: any) {
        setListError(err?.message || "No se pudo cargar la carpeta de Drive");
        if (!isRefresh) setListLoading(false);
      } finally {
        setRefreshing(false);
        // "listo" es la galeria pintada (con datos o con el error ya
        // mostrado), no "las miniaturas de las 40 tarjetas terminaron de
        // generarse": eso sigue en `pendingCount` y no bloquea el uso. Se
        // agenda un frame para avisar DESPUES de que React pinte, no antes.
        if (!isRefresh && !arranqueAvisadoRef.current) {
          arranqueAvisadoRef.current = true;
          requestAnimationFrame(() => {
            fase("render");
            onListo?.();
          });
        }
      }
    },
    [processItem, onListo]
  );

  useEffect(() => {
    const firma = (rutaInicial || []).join("/");
    if (rutaResueltaRef.current === firma) return;
    rutaResueltaRef.current = firma;
    (async () => {
      if (!folderTreeLoadedRef.current) {
        folderTreeCacheRef.current = await fetchAllFolderCache();
        folderTreeLoadedRef.current = true;
      }

      // Si la URL trae una ruta (/guada-y-flor-re/concepts), se resuelve
      // contra el arbol ya cacheado: comparar slugs es instantaneo y no hace
      // falta pegarle a Drive por cada nivel.
      const segmentos = rutaInicial || [];
      const pila: FolderCrumb[] = [ROOT_CRUMB];
      for (const slug of segmentos) {
        const actual = folderTreeCacheRef.current.get(pila[pila.length - 1].id);
        const hija = actual?.subfolders.find((f) => aSlug(f.name) === slug);
        if (!hija) break; // el resto de la ruta puede ser el archivo
        pila.push({ id: hija.id, name: hija.name });
      }
      if (pila.length > 1) setFolderStack(pila);
      const destino = pila[pila.length - 1];
      await loadFolder(destino.id, destino.name);

      // Lo que sobro de la ruta es el DIBUJO, y hay que abrirlo.
      //
      // Sin esto la ruta compartible funcionaba a medias: al abrir un dibujo
      // la URL pasaba a ser /carpeta/.../dibujo, pero si alguien pegaba ese
      // link solo llegaba a la carpeta y tenia que buscar el dibujo a mano.
      // O sea que el link decia a que plano apuntaba y no te llevaba ahi.
      const resto = segmentos.slice(pila.length - 1);
      if (resto.length !== 1) return;
      // `loadFolder` ya dejo el listado en el arbol cacheado.
      const archivos = folderTreeCacheRef.current.get(destino.id)?.files || [];
      const archivo = archivos.find((f) => aSlug(f.name) === resto[0]);
      if (archivo) {
        // Mismo evento que un click en la tarjeta (`handleOpen`): sin esto,
        // abrir por un link compartido/directo — que es exactamente para lo
        // que existe esta ruta — quedaba invisible en las metricas de uso.
        logAbrir(archivo.id, archivo.name, destino.id);
        // Misma invalidacion (esperada) que `handleOpen`: este camino la
        // saltaba por completo, asi que abrir por link directo un archivo
        // re-subido con contenido distinto mostraba el rasterizado viejo
        // cacheado en este dispositivo.
        await invalidarSiCambio(archivo.id, archivo.modifiedAt);
        onOpen(archivo.id, archivo.name, null, pila.slice(1).map((c) => c.name));
      }
    })();
  }, [loadFolder, rutaInicial, onOpen]);

  // Cada vez que cambia la carpeta, se avisa para que la URL la refleje.
  useEffect(() => {
    onRutaCambio?.(folderStack.slice(1).map((c) => c.name));
  }, [folderStack, onRutaCambio]);

  // La seleccion (archivos y/o carpetas enteras) se mantiene a proposito al
  // navegar entre carpetas, para poder juntar cosas de varios lugares y
  // descargarlas juntas.
  const goToStack = (nextStack: FolderCrumb[]) => {
    setFolderStack(nextStack);
    const target = nextStack[nextStack.length - 1];
    loadFolder(target.id, target.name);
  };

  const navigateInto = (folder: DriveFolderRef) => {
    goToStack([...folderStack, { id: folder.id, name: folder.name }]);
  };

  const navigateToCrumb = (index: number) => {
    goToStack(folderStack.slice(0, index + 1));
  };

  const navigateBack = () => {
    if (folderStack.length > 1) navigateToCrumb(folderStack.length - 2);
  };

  const handleRefresh = () => {
    if (refreshing || listLoading) return;
    loadFolder(currentFolder.id, currentFolder.name, { isRefresh: true });
  };

  // Abrir es inmediato: no se baja nada aca. El visor lee por rangos lo que
  // necesita (vista previa al instante, despues tree.pack, despues los
  // recursos visibles). Antes esto bajaba el archivo entero — hasta 262 MB —
  // antes de mostrar absolutamente nada.
  // useCallback con deps acotadas (no `items`/`selected`, que cambian en
  // cada tanda de miniaturas): es lo que permite que memoizar la tarjeta
  // mas abajo (`TarjetaArchivo`) sirva de algo. Sin esto, aunque el
  // componente estuviera envuelto en `React.memo`, recibir esta funcion con
  // identidad NUEVA en cada render invalidaria la memoizacion igual.
  const handleOpen = useCallback(async (item: GalleryItem, originRect: DOMRect | null) => {
    if (item.status === "processing") return;
    logAbrir(item.id, item.name, currentFolder.id);
    // Si el modifiedAt de Drive cambio desde la ultima vez que se abrio este
    // archivo EN ESTE DISPOSITIVO, el rasterizado que pueda haber cacheado en
    // IndexedDB corresponde al contenido viejo (el cache es por fileId, sin
    // relacion con el contenido); se descarta para que el visor rasterize de
    // nuevo en vez de mostrar el dibujo anterior.
    //
    // ESTO TIENE QUE TERMINAR ANTES de abrir el visor: antes se disparaba
    // sin esperar (`void invalidarSiCambio(...)`) y `onOpen` corria en el
    // mismo tick. `invalidarArchivo` hace un `getAll()` del indice mas una
    // transaccion de borrado por fila, así que el visor llegaba a leer
    // IndexedDB (`leerRasterVarios`) en decenas de ms, ANTES de que el
    // borrado terminara. Escenario real: alguien re-sube el mismo dibujo a
    // Drive con planos distintos; el usuario que ya lo habia abierto antes
    // tocaba la tarjeta y veia los planos VIEJOS con las anotaciones NUEVAS
    // encima -- exactamente lo que esta funcion existe para evitar.
    await invalidarSiCambio(item.id, item.modifiedAt);
    // La ruta sin la raiz: es lo que va en la URL compartible.
    onOpen(item.id, item.name, originRect, folderStack.slice(1).map((c) => c.name));
  }, [currentFolder.id, folderStack, onOpen]);

  // --- Tema, recientes y restablecer ------------------------------------
  const cambiarTema = () => setTema(alternarTema());

  useEffect(() => {
    void listarRecientes(6).then(setRecientes);
  }, [hidden]);

  const restablecerTodo = async () => {
    // Borra TODO lo local: rasterizados, recientes, nombre de usuario y tema.
    // No toca Drive ni Supabase — solo lo que esta guardado en este telefono.
    try {
      await vaciarCache();
      await vaciarRecientes();
      localStorage.clear();
      if (typeof caches !== "undefined") {
        const nombres = await caches.keys();
        await Promise.all(nombres.map((n) => caches.delete(n)));
      }
    } catch {
      /* si algo no se pudo borrar, igual se recarga */
    }
    window.location.href = "/";
  };

  // Update funcional (`setSelected(prev => ...)`): no necesita `selected`
  // en las dependencias, asi que con `[]` alcanza para que sea 100% estable.
  const toggleSelected = useCallback((ref: SelectedRef) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(ref.id)) next.delete(ref.id);
      else next.set(ref.id, ref);
      if (next.size === 0) setSelectionMode(false);
      return next;
    });
  }, []);

  const handleCheckboxClick = useCallback(
    (e: React.MouseEvent, ref: SelectedRef) => {
      e.stopPropagation();
      if (!selectionMode) setSelectionMode(true);
      toggleSelected(ref);
    },
    [selectionMode, toggleSelected]
  );

  const handleCardActivate = useCallback(
    (item: GalleryItem, el: HTMLElement) => {
      if (selectionMode) {
        toggleSelected({ kind: "file", id: item.id, name: item.name });
      } else {
        handleOpen(item, el.getBoundingClientRect());
      }
    },
    [selectionMode, toggleSelected, handleOpen]
  );

  // A diferencia de un archivo (que en modo seleccion no tiene otra accion
  // util al hacer click), una carpeta siempre tiene sentido abrirla — asi
  // que el click del cuerpo SIEMPRE navega, este o no activo el modo
  // seleccion; el checkbox (con su propio stopPropagation) es la unica
  // forma de marcarla para descarga. Si no fuera asi, no habria manera de
  // entrar a una carpeta nueva mientras se esta seleccionando en otra.
  const handleFolderActivate = (folder: DriveFolderRef) => {
    navigateInto(folder);
  };

  const cancelSelection = () => {
    setSelectionMode(false);
    setSelected(new Map());
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // Se pasa el File, no sus bytes: File.slice() es perezoso, asi que un
    // .concepts de 262 MB elegido a mano tampoco entra entero a memoria.
    onUpload(file, file.name);
  };

  // Baja recursivamente todos los archivos de una carpeta (y sus
  // subcarpetas, sin limite de profundidad) para armar una seccion de
  // descarga a partir de una carpeta seleccionada entera.
  //
  // `Promise.all(listing.folders.map(...))` sin limite: un arbol con 40
  // subcarpetas en 3 niveles disparaba ~40 requests simultaneas al proxy en
  // el nivel mas ancho, que a su vez hace 2 fetches a Drive cada una --
  // ~80 requests concurrentes a Drive. `driveClient.ts` documenta que Drive
  // devuelve 502 esporadicos cuando se lo apura; con esa rafaga el 502 deja
  // de ser esporadico, dispara reintentos con backoff, y el usuario ve el
  // boton de descarga "colgado" sin ningun indicio de por que. `runPool`
  // (definido mas abajo en este archivo) acota la concurrencia al mismo
  // numero que ya usa el resto de la galeria para no pegarle a Drive mas
  // fuerte de lo que el dispositivo/la red aguantan.
  const collectFolderFiles = async (folderId: string): Promise<{ id: string; name: string }[]> => {
    const listing = await listDriveFolder(folderId);
    const direct = listing.files.map((f) => ({ id: f.id, name: cleanName(f.name) }));
    const nestedPorCarpeta: { id: string; name: string }[][] = [];
    await runPool(listing.folders, getBudgets().concurrency, async (sub) => {
      nestedPorCarpeta.push(await collectFolderFiles(sub.id));
    });
    return direct.concat(nestedPorCarpeta.flat());
  };

  const handleDownload = async (format: "pdf" | "jpg") => {
    setShowFormatPicker(false);
    if (selected.size === 0) return;

    const refs = Array.from(selected.values());
    const fileRefs = refs.filter((r) => r.kind === "file");
    const folderRefs = refs.filter((r) => r.kind === "folder");

    // Se muestra ANTES de resolver que archivos hay que bajar, no despues:
    // `collectFolderFiles` puede tardar (recorre carpetas enteras, con la
    // concurrencia acotada de mas arriba) y sin esto el boton de descarga
    // se veia "colgado" sin ningun indicio de que algo estaba pasando
    // durante todo ese tiempo. `total: 0` se interpreta en el modal como
    // "todavia buscando", no como "0 archivos".
    setExportProgress({ done: 0, total: 0 });
    try {
      const plan: { title: string | null; files: { id: string; name: string }[] }[] = [];
      if (fileRefs.length > 0) {
        plan.push({
          title: folderRefs.length > 0 ? "Archivos seleccionados" : null,
          files: fileRefs.map((r) => ({ id: r.id, name: r.name })),
        });
      }
      for (const folderRef of folderRefs) {
        const files = await collectFolderFiles(folderRef.id);
        plan.push({ title: folderRef.name, files });
      }

      const totalFiles = plan.reduce((n, s) => n + s.files.length, 0);
      if (totalFiles === 0) {
        setListError("La seleccion no tiene archivos para descargar.");
        return;
      }

      setExportProgress({ done: 0, total: totalFiles });

      const metadata = await gatherExportMetadata();

      const sections: ExportSection[] = [];
      for (const group of plan) {
        const entries: ExportSection["entries"] = [];
        for (const f of group.files) {
          // Secuencial y codificando a JPEG apenas se renderiza: mantener
          // varios canvases de export vivos a la vez son cientos de MB.
          // renderDocumentEntry libera el canvas antes de seguir.
          const doc = await parseConceptsRemote(driveFileUrl(f.id), driveAuthHeaders());
          try {
            entries.push(await renderDocumentEntry(doc, f.name));
          } finally {
            doc.close();
          }
          setExportProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
        }
        sections.push({ title: group.title, entries });
      }

      if (format === "pdf") {
        await exportSectionsAsPdf(sections, metadata);
      } else {
        await exportSectionsAsZip(sections, metadata);
      }

      // Plano, no plan[0]: con varias carpetas seleccionadas, la unica
      // carpeta con contenido no tiene por que ser la primera del plan (una
      // carpeta vacia igual deja su entrada en `plan`), y plan[0].files[0]
      // podia no existir aunque el total fuera 1.
      const allFiles = plan.flatMap((s) => s.files);
      logDescarga(
        "galeria",
        format,
        allFiles.map((f) => f.id),
        allFiles.length === 1 ? allFiles[0].name : undefined,
        currentFolder.id
      );
      // La seleccion se mantiene activa a proposito: asi se puede volver a
      // descargar la misma seleccion en el otro formato sin re-marcar todo.
    } catch (err: any) {
      setListError(err?.message || "No se pudo generar la descarga");
    } finally {
      setExportProgress(null);
    }
  };

  // Memoizados: sin esto, cada uno de los `setItems` que dispara
  // `processItem` (dos por archivo, ver mas arriba) recorria TODOS los
  // items de nuevo solo para estos dos contadores, en cada uno de los
  // renders extra que ese mismo `setItems` ya provoca.
  const pendingCount = useMemo(
    () => items.filter((it) => it.status === "queued" || it.status === "processing").length,
    [items]
  );
  const cachedCount = useMemo(() => items.filter((it) => it.fromCache).length, [items]);
  const driveFolderUrl = `https://drive.google.com/drive/folders/${currentFolder.id}`;
  const isEmpty = !listLoading && folders.length === 0 && items.length === 0 && !listError;
  const selectedCount = selected.size;

  return (
    <div
      className="gallery-page"
      // `visibility: hidden`, no `display: none`: el visor ya se muestra
      // encima con `position: fixed` (`.viewer-hero`, cubre toda la
      // pantalla), asi que ocultar la galeria por debajo no necesita
      // sacarla del flujo. `display: none` colapsa el alto del elemento a
      // 0 -- al cerrar el dibujo, la galeria volvia a aparecer siempre
      // desde arriba, con el scroll perdido. Con `visibility: hidden` el
      // elemento conserva su tamaño mientras esta oculto, y con el la
      // posicion de scroll de la pagina.
      style={hidden ? { visibility: "hidden" } : undefined}
    >
      <header className="gallery-header">
        <div>
          <h1>ConceptSerializer</h1>
          <p className="gallery-subtitle">
            {userName ? `Bienvenido ${userName}. Selecciona tu lienzo o carpeta.` : "Dibujos disponibles en Drive"}
          </p>
        </div>
        <div className="gallery-header-actions">
          <a
            className="gallery-drive-btn"
            href={driveFolderUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FolderOpen size={16} /> Ver carpeta de Drive
          </a>
          <label className="gallery-upload-btn">
            <Upload size={16} /> Subir .concepts
            <input type="file" accept=".concepts" onChange={handleUpload} hidden />
          </label>
          <button
            className="gallery-icon-btn gallery-tema-btn"
            onClick={cambiarTema}
            title={tema === "oscuro" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
            aria-label={tema === "oscuro" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
          >
            {tema === "oscuro" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          {/* Accion destructiva: borra todo lo guardado en este dispositivo.
              Pide confirmacion porque no se puede deshacer. */}
          <button
            className="gallery-icon-btn gallery-reset-btn"
            onClick={() => setConfirmarReset(true)}
            title="Restablecer: borra el cache y los datos locales"
            aria-label="Restablecer datos locales"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </header>

      <div className="gallery-breadcrumb">
        <button
          className="gallery-icon-btn"
          onClick={() => navigateToCrumb(0)}
          disabled={folderStack.length === 1}
          title="Ir al inicio"
        >
          <Home size={15} />
        </button>
        <button
          className="gallery-icon-btn"
          onClick={navigateBack}
          disabled={folderStack.length === 1}
          title="Volver"
        >
          <ChevronLeft size={15} />
        </button>
        <div className="gallery-breadcrumb-trail">
          {folderStack.map((crumb, i) => (
            <span key={crumb.id} className="gallery-breadcrumb-crumb">
              {i > 0 && <ChevronRight size={12} className="gallery-breadcrumb-sep" />}
              <button
                className={`gallery-breadcrumb-item ${i === folderStack.length - 1 ? "current" : ""}`}
                onClick={() => navigateToCrumb(i)}
                disabled={i === folderStack.length - 1}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
        <button
          className="gallery-icon-btn"
          onClick={handleRefresh}
          disabled={refreshing || listLoading}
          title="Actualizar"
        >
          <RefreshCw size={15} className={refreshing ? "spin-slow" : ""} />
        </button>
      </div>

      {pendingCount > 0 && (
        <div className="gallery-status" role="status" aria-live="polite">
          <RefreshCw size={13} className="spin-slow" />
          Generando miniaturas: {items.length - pendingCount} de {items.length}
          {cachedCount > 0 ? ` (${cachedCount} desde cache)` : ""}
        </div>
      )}

      {listError && (
        <div className="gallery-error">
          <AlertTriangle size={16} /> {listError}
        </div>
      )}

      {/* Ultimos abiertos: solo en la raiz, para no tapar el contenido de la
          carpeta en la que estas. Guarda unicamente rutas (ver recientes.ts),
          asi que mostrarlos no cuesta ni red ni memoria. */}
      {folderStack.length === 1 && recientes.length > 0 && (
        <section className="gallery-recientes">
          <h2>
            <Clock size={14} /> Ultimos abiertos
          </h2>
          <div className="gallery-recientes-lista">
            {recientes.map((r) => (
              <button
                key={r.id}
                className="gallery-reciente"
                onClick={() => onOpen(r.id, r.nombre, null, r.ruta)}
                title={[...r.ruta, r.nombre].join(" / ")}
              >
                <span className="gallery-reciente-nombre">{r.nombre}</span>
                {r.ruta.length > 0 && <span className="gallery-reciente-ruta">{r.ruta.join(" / ")}</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {isEmpty && <div className="gallery-empty">Esta carpeta esta vacia.</div>}

      {listLoading ? (
        <div className="gallery-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="gallery-card skeleton" key={i}>
              <div className="gallery-thumb skeleton-shimmer" />
              <div className="gallery-name skeleton-line" />
            </div>
          ))}
        </div>
      ) : (
        <>
          {folders.length > 0 && (
            <div className="gallery-grid gallery-folders-grid">
              {folders.map((folder, idx) => {
                const checked = selected.has(folder.id);
                return (
                  <div
                    key={folder.id}
                    className={`gallery-card folder-card ${checked ? "selected" : ""}`}
                    style={{ animationDelay: `${Math.min(idx, 12) * 35}ms` }}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleFolderActivate(folder)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleFolderActivate(folder);
                      }
                    }}
                    title={folder.name}
                  >
                    <button
                      type="button"
                      className={`gallery-checkbox ${checked ? "checked" : ""}`}
                      onClick={(e) => handleCheckboxClick(e, { kind: "folder", id: folder.id, name: folder.name })}
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={checked ? "Deseleccionar carpeta" : "Seleccionar carpeta"}
                    >
                      {checked ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                    </button>
                    <div className="gallery-thumb folder-thumb">
                      <Folder size={30} />
                    </div>
                    <div className="gallery-name">{folder.name}</div>
                  </div>
                );
              })}
            </div>
          )}

          {items.length > 0 && (
            <div className="gallery-grid">
              {items.map((item, idx) => (
                <TarjetaArchivo
                  key={item.id}
                  item={item}
                  idx={idx}
                  checked={selected.has(item.id)}
                  onActivate={handleCardActivate}
                  onToggleCheck={handleCheckboxClick}
                />
              ))}
            </div>
          )}
        </>
      )}

      <AnimatePresence>
        {toast && (
          <m.div
            className="gallery-toast"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.4, ease: EASE_IOS }}
          >
            {toast}
          </m.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selectionMode && (
          <m.div
            className="gallery-toolbar"
            initial={{ opacity: 0, y: 24, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}
          >
            <span>{selectedCount} seleccionado{selectedCount === 1 ? "" : "s"}</span>
            <div className="gallery-toolbar-actions">
              <button className="gallery-toolbar-btn primary" onClick={() => setShowFormatPicker(true)}>
                <Download size={15} /> Descargar
              </button>
              <button className="gallery-toolbar-btn" onClick={cancelSelection} title="Cancelar seleccion">
                <X size={16} />
              </button>
            </div>
          </m.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showFormatPicker && (
          <m.div
            className="gallery-modal-overlay"
            onClick={() => setShowFormatPicker(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE_IOS }}
          >
            <m.div
              className="gallery-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="titulo-modal-formato"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 10 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
            >
              <h3 id="titulo-modal-formato">Descargar {selectedCount} elemento{selectedCount === 1 ? "" : "s"}</h3>
              <p>Elegi el formato de descarga.</p>
              <div className="gallery-modal-options">
                <button className="gallery-modal-option" onClick={() => handleDownload("pdf")}>
                  <FileText size={20} />
                  <span>PDF</span>
                  <small>Un solo PDF con metadata y secciones por carpeta</small>
                </button>
                <button className="gallery-modal-option" onClick={() => handleDownload("jpg")}>
                  <ImageIcon size={20} />
                  <span>JPG</span>
                  <small>Un .zip con un JPG por dibujo (y subcarpetas)</small>
                </button>
              </div>
              <button className="gallery-modal-cancel" onClick={() => setShowFormatPicker(false)}>
                Cancelar
              </button>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {confirmarReset && (
          <m.div
            className="gallery-modal-overlay"
            onClick={() => setConfirmarReset(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE_IOS }}
          >
            <m.div
              className="gallery-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="titulo-modal-reset"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 10 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
            >
              <h3 id="titulo-modal-reset">Restablecer</h3>
              <p>
                Se borra todo lo guardado en <strong>este dispositivo</strong>: el cache de dibujos ya
                abiertos, la lista de recientes, tu nombre y el tema. No se borra nada de Drive ni de
                los dibujos.
              </p>
              <p>La proxima apertura vuelve a bajar y rasterizar todo, asi que sera mas lenta.</p>
              <div className="gallery-modal-options">
                <button className="gallery-modal-option peligro" onClick={restablecerTodo}>
                  <Trash2 size={20} />
                  <span>Borrar y recargar</span>
                  <small>No se puede deshacer</small>
                </button>
              </div>
              <button className="gallery-modal-cancel" onClick={() => setConfirmarReset(false)}>
                Cancelar
              </button>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {exportProgress && (
          <m.div
            className="gallery-modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE_IOS }}
          >
            <m.div
              className="gallery-modal"
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
            >
              <RefreshCw size={20} className="spin-slow" />
              <p>
                {exportProgress.total === 0
                  ? "Buscando archivos…"
                  : `Preparando descarga: ${exportProgress.done} de ${exportProgress.total}`}
              </p>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default Gallery;
