import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { openConceptsRemote, openConceptsLocal } from './parser';
import type { Document } from './parser';
import { SeguidorProgreso, TEXTO_FASE, formatearRestante, formatearMB } from './progreso';
import type { EstadoProgreso } from './progreso';
import { Viewer } from './Viewer';
import type { LayerConfig, ViewerHandle } from './Viewer';
import { InteractivePreview } from './InteractivePreview';
import { logDescarga, logAbrir, logAbrirError, logTema } from '../Gallery/analytics';
import { driveFileUrl, driveAuthHeaders } from '../Gallery/driveClient';
import type { FileSourceRef } from '../App';
import {
  Eye, EyeOff, Lock, Filter, Image as ImageIcon, X, Download, Maximize2,
  ZoomIn, ZoomOut, Maximize, Minimize, Sun, Moon,
  ChevronLeft, ChevronRight, Link2, Check, Keyboard,
} from 'lucide-react';
import { alternarTema, temaGuardado } from '../theme';
import type { Tema } from '../theme';
import { fallo } from '../lib/centinela';
import { codigoDeErrorDescarga, detalleProxy, parseRangoFallido } from '../lib/erroresDescarga';
import './App.css';

interface ViewerProps {
  source: FileSourceRef;
  onClose: () => void;
}

/**
 * Barra de carga con fase, porcentaje real y tiempo estimado.
 *
 * El porcentaje sale de los bytes que de verdad hay que traer (se conocen
 * apenas se lee el indice del zip). Mientras no se sepa, la barra va
 * indeterminada en vez de mostrar un numero inventado.
 */
function BarraCarga({ progreso }: { progreso: EstadoProgreso | null }) {
  if (!progreso || progreso.fase === 'listo') return null;
  const pct = progreso.porcentaje;
  const restante = formatearRestante(progreso.segundosRestantes);

  return (
    <div className="viewer-carga" role="status" aria-live="polite">
      <div className="viewer-carga-cabecera">
        <span className="viewer-loading-dot" />
        <span className="viewer-carga-fase">{TEXTO_FASE[progreso.fase]}</span>
        {progreso.detalle && <span className="viewer-carga-detalle">{progreso.detalle}</span>}
        {pct !== null && <span className="viewer-carga-pct">{Math.round(pct)}%</span>}
      </div>
      <div className={`viewer-carga-riel ${pct === null ? 'indeterminada' : ''}`}>
        <div className="viewer-carga-relleno" style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <div className="viewer-carga-pie">
        <span>
          {formatearMB(progreso.bytesRecibidos)}
          {progreso.bytesEsperados ? ` de ${formatearMB(progreso.bytesEsperados)}` : ''}
          {progreso.velocidadKBs ? ` · ${progreso.velocidadKBs} kB/s` : ''}
        </span>
        {restante && <span>faltan {restante}</span>}
      </div>
    </div>
  );
}

interface LayerMenuProps {
  layers: Document['layers'];
  layerConfigs: Record<string, LayerConfig>;
  isolatedLayer: string | null;
  open: boolean;
  layerCount: number;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggleOpen: () => void;
  onSetOpacity: (id: string, opacity: number) => void;
  onToggleVisibility: (id: string) => void;
  onToggleIsolate: (id: string) => void;
  onReset: () => void;
  onToggleAll: () => void;
}

/**
 * Icono + desplegable de capas, separado de `ConceptViewer` y memoizado.
 *
 * Perfilado real (bench ad-hoc arrastrando el slider de opacidad, CPU x6):
 * cada tick de `input` volvia a ejecutar TODO el render de `ConceptViewer`
 * (createElement/jsxDEV ~4s de self-time en 40 ticks), porque toolbar,
 * menu de export y galeria de imagenes vivian inline en el mismo componente
 * que el estado `layerConfigs`. Al vivir aca, con props estables (los
 * callbacks son `useCallback` en el padre), arrastrar UN slider ya no
 * reconstruye los iconos ni el resto de los menus.
 */
const LayerMenu = memo(function LayerMenu({
  layers, layerConfigs, isolatedLayer, open, layerCount, menuRef,
  onToggleOpen, onSetOpacity, onToggleVisibility, onToggleIsolate, onReset, onToggleAll,
}: LayerMenuProps) {
  return (
    <div className="dropdown-container" ref={menuRef}>
      <button
        className={`btn-tool ${open ? 'active-glow' : ''}`}
        onClick={onToggleOpen}
        title={`Capas: ${layerCount}`}
        aria-label={`Capas: ${layerCount}`}
      >
        <Filter size={20} />
      </button>

      {open && (
        <div className="layer-menu dropdown-menu">
          <div className="layer-menu-header">
            <span>Capas</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button className="btn btn-tiny" onClick={onReset}>Restablecer</button>
              <button className="btn btn-tiny" onClick={onToggleAll}>Alternar</button>
            </div>
          </div>
          <div className="layer-list">
            {layers.map((l, i) => (
              <div key={l.id} className={`layer-item ${isolatedLayer === l.id ? 'isolated' : ''}`}>
                <div className="layer-info">
                  <span className="layer-name">Capa {i + 1}</span>
                  <span style={{ fontSize: '0.75rem', color: '#888' }}>
                    ({l.strokes.length + l.images.length} elem)
                  </span>
                </div>
                <div className="layer-actions">
                  <input
                    type="range"
                    min="0" max="1" step="0.05"
                    value={layerConfigs[l.id]?.opacity ?? 1}
                    onChange={(e) => onSetOpacity(l.id, parseFloat(e.target.value))}
                    className="opacity-slider"
                    title="Opacidad"
                  />
                  <button
                    className="icon-btn"
                    onClick={() => onToggleVisibility(l.id)}
                    title="Mostrar/Ocultar"
                  >
                    {layerConfigs[l.id]?.visible ? <Eye size={16} /> : <EyeOff size={16} color="#aaa" />}
                  </button>
                  <button
                    className={`icon-btn ${isolatedLayer === l.id ? 'active-icon' : ''}`}
                    onClick={() => onToggleIsolate(l.id)}
                    title="Aislar capa"
                  >
                    <Lock size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

interface ImageMenuProps {
  open: boolean;
  imageCount: number;
  resourceIds: string[];
  imageUrls: Record<string, string>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggleOpen: () => void;
  onOpenPhoto: (resourceId: string, thumbUrl: string) => void;
}

/** Icono + desplegable de galeria de imagenes, mismo motivo que
 * `LayerMenu`: separado y memoizado para que abrir este desplegable no
 * reconstruya el menu de capas ni la toolbar. La opacidad de las imagenes
 * vive en su propia barra flotante (`.opacidad-bar`, mas abajo), no aca
 * adentro -- antes habia que abrir este menu para encontrarla. */
const ImageMenu = memo(function ImageMenu({
  open, imageCount, resourceIds, imageUrls, menuRef,
  onToggleOpen, onOpenPhoto,
}: ImageMenuProps) {
  return (
    <div className="dropdown-container" ref={menuRef}>
      <button
        className={`btn-tool ${open ? 'active-glow' : ''}`}
        onClick={onToggleOpen}
        title={`Imágenes: ${imageCount}`}
        aria-label={`Imágenes: ${imageCount}`}
      >
        <ImageIcon size={20} />
      </button>

      {open && (
        <div className="image-menu dropdown-menu">
          <div className="layer-menu-header">
            <span>Galería</span>
            <span style={{ fontSize: '0.7rem', color: '#888' }}>ESC para cerrar</span>
          </div>
          <div className="image-gallery">
            {resourceIds.length > 0 ? resourceIds.map((id) => {
              const url = imageUrls[id];
              return (
                <div
                  key={id}
                  className={`gallery-item ${url ? '' : 'gallery-item-lejos'}`}
                  onClick={() => url && onOpenPhoto(id, url)}
                  title={url ? 'Ver la foto' : 'Acercate en el dibujo para traerla'}
                >
                  {url ? (
                    <img src={url} alt="Recurso" />
                  ) : (
                    <span className="gallery-item-aviso">Acercate<br />para verla</span>
                  )}
                </div>
              );
            }) : (
              <div style={{ padding: '1rem', textAlign: 'center', color: '#888' }}>No hay recursos embebidos.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export function ConceptViewer({ source, onClose }: ViewerProps) {
  const fileName = source.name;
  const fileId = source.kind === 'remote' ? source.fileId : null;
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Codigo del catalogo del fallo que dejo `error` (F4001/F4002/F4003/F4005),
   * para mostrarlo junto al mensaje: "no un spinner eterno" (F2_MODULOS.md
   * R2-04) tambien significa que la persona tenga algo para mandar. */
  const [errorCodigo, setErrorCodigo] = useState<string | null>(null);
  /** Se incrementa con el boton "Reintentar": esta en las deps del efecto de
   * abajo, asi que fuerza a repetir la apertura sin cambiar `source`. */
  const [intentoReintento, setIntentoReintento] = useState(0);
  const [stats, setStats] = useState<{ layers: number; strokes: number; images: number } | null>(null);
  // Vista previa que Concepts guarda dentro del archivo. Se muestra apenas
  // llega (~110 KB por rangos, menos de un segundo) mientras se decodifica el
  // documento: el usuario ve SU dibujo enseguida en vez de un lienzo vacio.
  const [placeholder, setPlaceholder] = useState<string | null>(null);
  // Los trazos se ven enseguida; las fotos/PDFs embebidos tardan un poco mas
  // en rasterizarse. Se avisa en vez de dejar el lienzo a medio dibujar sin
  // explicacion.
  const [recursosListos, setRecursosListos] = useState(false);
  const [progreso, setProgreso] = useState<EstadoProgreso | null>(null);
  /** Cuantos planos se estan afinando y cuantos hay que traer de la red. Se
   * distinguen porque para el usuario no es lo mismo esperar un instante que
   * esperar 30 s de 4G. */
  const [refinando, setRefinando] = useState({ afinar: 0, traer: 0 });
  /**
   * Se saca la vista previa de encima cuando TODO lo que cae en el viewport
   * ya tiene bitmap real (`onCoberturaLista` del Viewer), o cuando se cumple
   * el techo de espera de mas abajo (lo que llegue primero).
   *
   * Antes se descartaba con el primer recurso que llegaba
   * (`progresoRecursos.listos > 0`) O con el primer gesto del usuario: un
   * dibujo con 19 planos mostraba 1 real y 18 huecos casi negros durante el
   * resto de la carga, y un toque accidental al 3% dejaba esos huecos
   * visibles de forma PERMANENTE. El objetivo es que nunca se vea nada a
   * medio cargar: se tapa todo con la vista previa hasta que reemplazarla no
   * deja huecos.
   */
  const [previaDescartada, setPreviaDescartada] = useState(false);
  /** Planos que no se pudieron traer. Se avisa en vez de decir "listo". */
  const [fallidos, setFallidos] = useState(0);
  const seguidorRef = useRef<SeguidorProgreso | null>(null);

  /** Techo de espera para la cobertura del lienzo: si algun recurso falla o
   * tarda demasiado, se revela igual (con el aviso de "N planos no se
   * pudieron cargar" que ya existe) en vez de dejar al usuario mirando la
   * vista previa para siempre. */
  const TECHO_ESPERA_COBERTURA_MS = 12_000;
  const coberturaTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const alCoberturaLista = useCallback(() => {
    if (coberturaTimeoutRef.current) {
      clearTimeout(coberturaTimeoutRef.current);
      coberturaTimeoutRef.current = null;
    }
    setPreviaDescartada(true);
    // Backstop para la fase "listo" de la barra de carga (normalmente la
    // pone `onResourcesReady`, ver `alTerminarRecursos`). Se observo en
    // pruebas manuales que el contador interno de `cargarRecursos`
    // ("N de M imagenes") puede quedar pegado un numero por debajo del
    // total incluso cuando TODOS los recursos visibles ya tienen bitmap
    // (confirmado con `getStats().tiempos.n` == cantidad total) -- una
    // carrera fina entre el timeout/onEach de un recurso puntual que no se
    // pudo aislar con confianza sin arriesgar romper el pipeline de carga.
    // La cobertura (este mismo callback) es una señal MAS confiable de
    // "no queda nada visible sin cargar" que ese contador: si ya disparo,
    // no tiene sentido dejar la barra de carga girando para siempre.
    setRecursosListos(true);
    seguidorRef.current?.cambiarFase('listo');
  }, []);

  // Layer State
  const [layerConfigs, setLayerConfigs] = useState<Record<string, LayerConfig>>({});
  const [isolatedLayer, setIsolatedLayer] = useState<string | null>(null);
  /** Opacidad SOLO de las fotos/PDFs, independiente de la opacidad por capa
   * (esa mezcla trazos e imagenes de la misma capa). Vive aca y no por capa
   * porque el pedido es "las imagenes mas tenues", sin importar en que capa
   * este cada una. */
  const [imageOpacity, setImageOpacity] = useState(1);
  const [exportZoomAll, setExportZoomAll] = useState(true);
  
  // UI State
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [showImageMenu, setShowImageMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Tema del visor abierto: antes solo se podia cambiar desde la galeria (hay
  // que cerrar el dibujo para volver a verla), asi que alguien mirando un
  // plano de noche quedaba pegado al tema con el que abrio. El propio Viewer
  // ya escucha el evento "concepts:tema" (ver Viewer.tsx) para repintar el
  // lienzo, asi que alcanza con alternarlo aca igual que hace la galeria.
  const [tema, setTema] = useState<Tema>(() => temaGuardado());
  const alternarTemaViewer = useCallback(() => {
    const nuevo = alternarTema();
    setTema(nuevo);
    logTema(nuevo, 'lienzo');
  }, []);

  // Fullscreen real del navegador (distinto de "ver todo el dibujo": ese
  // encuadra el CONTENIDO, este oculta la barra del navegador). Se escucha
  // `fullscreenchange` en vez de confiar solo en el propio click porque el
  // usuario puede salir con Esc o F11, que no pasan por este boton.
  const [enFullscreen, setEnFullscreen] = useState(false);
  useEffect(() => {
    const alCambiar = () => setEnFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', alCambiar);
    return () => document.removeEventListener('fullscreenchange', alCambiar);
  }, []);
  // Navegacion entre laminas: en dibujos con varios PDF colocados (un plano
  // por piso, por ejemplo) ir a buscar cada uno a mano con pan/zoom es
  // tedioso. El indice es circular (vuelve al primero despues del ultimo) y
  // vive en un ref ademas de en estado: los botones necesitan leer el total
  // ACTUAL de planos (que llega recien cuando `doc` esta listo) sin agregar
  // ese valor como dependencia de los callbacks.
  const [planoActual, setPlanoActual] = useState(0);
  useEffect(() => setPlanoActual(0), [doc]);
  const irAPlano = useCallback((delta: number) => {
    const total = viewerRef.current?.cantidadPlanos() ?? 0;
    if (total === 0) return;
    setPlanoActual((actual) => {
      const siguiente = ((actual + delta) % total + total) % total;
      viewerRef.current?.irAPlano(siguiente);
      return siguiente;
    });
  }, []);

  const [enlaceCopiado, setEnlaceCopiado] = useState(false);
  const copiarEnlace = useCallback(() => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setEnlaceCopiado(true);
      setTimeout(() => setEnlaceCopiado(false), 1500);
    });
  }, []);

  const [showAtajos, setShowAtajos] = useState(false);
  const atajosMenuRef = useRef<HTMLDivElement>(null);

  const alternarFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      // El contenedor del visor entero (no solo el canvas): asi la barra de
      // herramientas y el boton de cerrar siguen visibles en fullscreen.
      void document.documentElement.requestFullscreen().catch(() => {
        // Algunos navegadores (Safari de escritorio viejo, ciertos webviews)
        // no soportan la API o la rechazan; sin este catch, un click ahi
        // tiraba un unhandled rejection a la consola sin ningun efecto visible.
      });
    }
  }, []);

  // Image Thumbnails & Preview State
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  // La miniatura de la galeria (`imageUrls[id]`) es una previsualizacion
  // chica (384px de lado, ver `pedirPreviews` en Viewer.tsx) sacada del
  // bitmap que en ESE momento tenga cacheado el lienzo principal — que
  // puede ser un RECORTE si el usuario hizo zoom sobre ese recurso. Abrir
  // la foto a pantalla completa mostrando eso directamente es el bug de
  // "sale recortada y nunca llega a full HD": no hay ningun pedido de mas
  // resolucion, la miniatura chica es lo unico que se muestra siempre.
  // Ahora se abre con esa miniatura al instante (no dejar la pantalla en
  // blanco) y en paralelo se pide la version completa sin recortar
  // (`obtenerImagenCompleta`, ver Viewer.tsx) para reemplazarla apenas
  // llega.
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  /** Identidad de la foto que se esta mostrando (el resourceId), separada
   * de `previewImage`: ver el comentario de `photoId` en
   * InteractivePreview.tsx -- es lo que le permite a ese componente saber
   * que la miniatura y la version completa son la MISMA foto. */
  const [previewPhotoId, setPreviewPhotoId] = useState<string | null>(null);
  const [previewLoadingFull, setPreviewLoadingFull] = useState(false);
  // Se incrementa en cada apertura/cierre: si el pedido de full-res de una
  // foto vieja resuelve DESPUES de que el usuario ya cerro o abrio otra,
  // este token evita que ese resultado tardio pise la foto actual (o
  // reabra el visor de fotos ya cerrado).
  const previewTokenRef = useRef(0);
  // `obtenerImagenCompleta` (Viewer.tsx) devuelve un ObjectURL, no un data
  // URL: mas liviano y no bloquea el hilo principal para codificarlo, pero
  // a diferencia de un data URL alguien tiene que revocarlo o el blob queda
  // vivo en memoria el resto de la sesion. Se guarda aparte del propio
  // `previewImage` (que puede ser la miniatura en base64 mientras la
  // version completa todavia no llego) para saber exactamente cual hay que
  // revocar y cual no.
  const previewFullUrlRef = useRef<string | null>(null);

  const cerrarFoto = useCallback(() => {
    previewTokenRef.current++;
    setPreviewImage(null);
    setPreviewPhotoId(null);
    setPreviewLoadingFull(false);
    if (previewFullUrlRef.current) {
      URL.revokeObjectURL(previewFullUrlRef.current);
      previewFullUrlRef.current = null;
    }
  }, []);

  const abrirFoto = useCallback((resourceId: string, thumbUrl: string) => {
    previewTokenRef.current++;
    const token = previewTokenRef.current;
    // La foto ANTERIOR (si habia una) ya no se va a mostrar: se revoca su
    // ObjectURL aca, no solo en `cerrarFoto`, porque abrir una foto nueva
    // sin cerrar la anterior (click directo de una a otra en la galeria) es
    // un camino real que no pasa por `cerrarFoto`.
    if (previewFullUrlRef.current) {
      URL.revokeObjectURL(previewFullUrlRef.current);
      previewFullUrlRef.current = null;
    }
    setPreviewImage(thumbUrl);
    setPreviewPhotoId(resourceId);
    setPreviewLoadingFull(true);
    void viewerRef.current
      ?.obtenerImagenCompleta(resourceId)
      .then((full) => {
        if (previewTokenRef.current !== token) {
          // Esta foto ya no es la que se esta mostrando (el usuario cerro o
          // abrio otra mientras se generaba): igual llego un ObjectURL
          // valido que nadie va a usar, y hay que revocarlo aca porque
          // nunca va a pasar por `previewFullUrlRef`.
          if (full) URL.revokeObjectURL(full);
          return;
        }
        if (full) {
          previewFullUrlRef.current = full;
          setPreviewImage(full);
        }
        setPreviewLoadingFull(false);
      })
      .catch(() => {
        if (previewTokenRef.current !== token) return;
        setPreviewLoadingFull(false);
      });
  }, []);

  const layerMenuRef = useRef<HTMLDivElement>(null);
  const imageMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerHandle>(null);

  // Expuesto para benchmarks/diagnostico, mismo patron que
  // `__conceptsPedirPreviews` en Viewer.tsx: permite probar el flujo
  // miniatura -> full HD de la galeria de fotos sin instrumentar la UI.
  useEffect(() => {
    (window as any).__conceptsAbrirFoto = abrirFoto;
    (window as any).__conceptsPreviewState = () => ({ previewImage, previewLoadingFull });
    (window as any).__conceptsResourceIds = () => doc?.resourceIds ?? [];
    return () => {
      delete (window as any).__conceptsAbrirFoto;
      delete (window as any).__conceptsPreviewState;
      delete (window as any).__conceptsResourceIds;
    };
  }, [abrirFoto, previewImage, previewLoadingFull, doc]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowLayerMenu(false);
        setShowImageMenu(false);
        setShowExportMenu(false);
        setShowAtajos(false);
        cerrarFoto();
        return;
      }
      // Atajos de zoom/navegacion. Se ignoran si el foco esta en un campo de
      // formulario (el slider de opacidad de capas usa +/-/flechas para SU
      // propio valor; sin esta guarda, tocar el slider tambien movia el
      // lienzo entero por debajo).
      const activo = document.activeElement;
      const enCampo = activo && /^(INPUT|TEXTAREA|SELECT)$/.test(activo.tagName);
      if (enCampo || previewImage) return;
      switch (e.key) {
        case '+':
        case '=':
          e.preventDefault();
          viewerRef.current?.zoomIn();
          break;
        case '-':
        case '_':
          e.preventDefault();
          viewerRef.current?.zoomOut();
          break;
        case '0':
          viewerRef.current?.zoomAll();
          break;
        case 'f':
        case 'F':
          alternarFullscreen();
          break;
        case ']':
        case 'ArrowRight':
          if (e.key === ']' || e.altKey) irAPlano(1);
          break;
        case '[':
        case 'ArrowLeft':
          if (e.key === '[' || e.altKey) irAPlano(-1);
          break;
        case '?':
          setShowAtajos((v) => !v);
          break;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [cerrarFoto, previewImage, alternarFullscreen, irAPlano]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (previewImage) return; // Prevent closing dropdowns when interacting with preview
      
      if (layerMenuRef.current && !layerMenuRef.current.contains(e.target as Node)) {
        setShowLayerMenu(false);
      }
      if (imageMenuRef.current && !imageMenuRef.current.contains(e.target as Node)) {
        setShowImageMenu(false);
      }
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
      if (atajosMenuRef.current && !atajosMenuRef.current.contains(e.target as Node)) {
        setShowAtajos(false);
      }
    };
    if (showLayerMenu || showImageMenu || showExportMenu || showAtajos) {
      document.addEventListener('mousedown', handleClickOutside, true);
      document.addEventListener('touchstart', handleClickOutside, true);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('touchstart', handleClickOutside, true);
    };
  }, [showLayerMenu, showImageMenu, showExportMenu, showAtajos, previewImage]);

  useEffect(() => {
    setRecursosListos(false);
    setPreviaDescartada(false);
    setFallidos(0);
    setPlaceholder(null);
    setDoc(null);
    setStats(null);
    setError(null);
    setErrorCodigo(null);
    if (coberturaTimeoutRef.current) clearTimeout(coberturaTimeoutRef.current);
    coberturaTimeoutRef.current = setTimeout(() => {
      coberturaTimeoutRef.current = null;
      setPreviaDescartada(true);
    }, TECHO_ESPERA_COBERTURA_MS);
    let cancelado = false;
    faseDibujandoRef.current = false;
    let docCreado: Document | null = null;
    let urlPlaceholder: string | null = null;

    // Reporta al centinela un fallo al abrir/leer el .concepts, con el
    // codigo del catalogo que corresponda. Desde R3-01 el codigo lo pone la
    // propia Edge Function (UNX-F4005 para un rango, UNX-F7001 para el resto
    // de sus fallos) y viene con `causa` y el `id` de su linea en los logs de
    // Supabase: sin ese id, una fila de `unx_fallos` y el log del backend no
    // se pueden cruzar. `fileId` solo si el origen es remoto: un archivo
    // local no tiene nada que ver con el proxy.
    const reportarFalloDescarga = (err: unknown) => {
      const codigo = codigoDeErrorDescarga(err);
      setErrorCodigo(codigo);
      const mensaje = err instanceof Error ? err.message : String(err);
      const delProxy = detalleProxy(err);
      const detalleRango = delProxy
        ? { range: delProxy.range, status: delProxy.status }
        : parseRangoFallido(mensaje);
      fallo(codigo, {
        fileId: source.kind === 'remote' ? source.fileId : undefined,
        ...(detalleRango || {}),
        ...(delProxy?.causa ? { causa: delProxy.causa } : {}),
        ...(delProxy?.idFallo ? { idFallo: delProxy.idFallo } : {}),
      });
      logAbrirError(
        source.kind === 'remote' ? source.fileId : null,
        fileName,
        null,
        codigo,
        mensaje
      );
    };

    const seguidor = new SeguidorProgreso((e) => {
      if (!cancelado) setProgreso(e);
    });
    seguidorRef.current = seguidor;
    seguidor.cambiarFase('abriendo');

    (async () => {
      // El archivo se abre UNA sola vez y de ahi salen las dos cosas: la
      // vista previa y el documento. Abrir dos lectores pagaba dos veces la
      // lectura del indice del zip, que a traves del proxy de Drive es una
      // ida y vuelta de ~1,7 s.
      let archivo: Awaited<ReturnType<typeof openConceptsRemote>>;
      try {
        archivo =
          source.kind === 'remote'
            ? await openConceptsRemote(driveFileUrl(source.fileId), driveAuthHeaders(), {
                onBytes: (n) => seguidor.sumarBytes(n),
              })
            : await openConceptsLocal(source.file);
      } catch (err: any) {
        if (!cancelado) {
          setError(err?.message || 'No se pudo abrir el archivo');
          reportarFalloDescarga(err);
        }
        return;
      }
      if (cancelado) {
        archivo.close();
        return;
      }

      // La vista previa (thumb.jpg, ~110 KB) y el documento (tree.pack, ~1 MB)
      // viven en offsets DISTINTOS del mismo zip: no hay ninguna dependencia
      // real entre pedirlos. Antes se esperaba el thumbnail ENTERO antes de
      // arrancar el pedido de tree.pack, asi que el segundo rango ni siquiera
      // salia a la red hasta que volvia el primero — en una conexion con
      // latencia (el proxy de Drive agrega ~1,7 s de por si) eso es tiempo
      // muerto sumado en serie por nada. Se piden los dos A LA VEZ y cada uno
      // actualiza la UI en cuanto el suyo llega, sin esperar al otro.
      seguidor.cambiarFase('descargando', 'vista previa y documento');
      const [resThumb, resDoc] = await Promise.allSettled([archivo.thumbnail(), archivo.parse()]);

      if (resThumb.status === 'fulfilled' && resThumb.value && !cancelado) {
        urlPlaceholder = URL.createObjectURL(resThumb.value);
        setPlaceholder(urlPlaceholder);
      }
      // Sin vista previa (fallo o el archivo no la trae) se sigue igual.

      if (resDoc.status === 'rejected') {
        if (!cancelado) {
          setError(resDoc.reason?.message || 'Error al cargar el archivo');
          reportarFalloDescarga(resDoc.reason);
        }
      } else {
        seguidor.cambiarFase('procesando', 'trazos y capas');
        const parsedDoc = resDoc.value;
        if (cancelado) {
          parsedDoc.close();
          return;
        }
        docCreado = parsedDoc;
        // Aca NO se fija el total: `bytesNecesarios` suma TODOS los recursos
        // colocados, y el visor solo baja los que entran en pantalla y son lo
        // bastante grandes. El total real lo informa el visor apenas decide
        // que va a traer (`onBytesPrevistos`); hasta entonces la barra va
        // indeterminada, que es honesto.

        let strokesCount = 0;
        let imagesCount = 0;
        const initialConfigs: Record<string, LayerConfig> = {};

        parsedDoc.layers.forEach(l => {
          strokesCount += l.strokes.length;
          imagesCount += l.images.length;
          initialConfigs[l.id] = { visible: true, opacity: 1.0 };
        });

        setLayerConfigs(initialConfigs);
        setIsolatedLayer(null);
        setStats({ layers: parsedDoc.layers.length, strokes: strokesCount, images: imagesCount });
        setDoc(parsedDoc);
        logAbrir(source.kind === 'remote' ? source.fileId : '', fileName, '');
        seguidor.cambiarFase(
          parsedDoc.resourceIds.length > 0 ? 'descargando' : 'listo',
          parsedDoc.resourceIds.length > 0 ? `0 de ${parsedDoc.resourceIds.length} imágenes` : null
        );
      }
    })();

    return () => {
      cancelado = true;
      // Cerrar el documento suelta el archivo y las conexiones de rango. Sin
      // esto, abrir y cerrar dibujos pesados va dejando fuentes vivas.
      docCreado?.close();
      if (urlPlaceholder) URL.revokeObjectURL(urlPlaceholder);
      if (coberturaTimeoutRef.current) {
        clearTimeout(coberturaTimeoutRef.current);
        coberturaTimeoutRef.current = null;
      }
    };
    // `intentoReintento`: el boton "Reintentar" de la pantalla de error lo
    // incrementa para forzar que este efecto se repita con el MISMO
    // `source` (sin esto, reabrir el mismo dibujo tras un fallo no hacia
    // nada: las deps no habian cambiado).
  }, [source, intentoReintento]);

  // Los callbacks que recibe el Viewer se declaran con identidad ESTABLE.
  //
  // Escritos como arrows inline, cada render de este componente le pasaba al
  // Viewer cuatro funciones nuevas. Y este componente re-renderiza mucho
  // durante la carga: el progreso de bytes avisa ~10 veces por segundo y cada
  // recurso que termina dispara otro. Con props nuevas, `React.memo` no sirve
  // de nada y el Viewer se re-renderiza entero cada vez — en el perfil de una
  // tanda de gestos, React era el 13% del hilo principal.
  const alCargarImagenes = useCallback((urls: Record<string, string>) => {
    setImageUrls(urls);
  }, []);

  const alTerminarRecursos = useCallback(() => {
    setRecursosListos(true);
    seguidorRef.current?.cambiarFase('listo');
  }, []);

  const faseDibujandoRef = useRef(false);
  const alAvanzarRecursos = useCallback((listos: number, total: number) => {
    // La fase se cambia UNA vez; el resto de los avisos van por `fijarDetalle`,
    // que respeta el limitador de 100 ms. `cambiarFase` fuerza el aviso, asi
    // que llamarlo por cada recurso provocaba un render extra cada vez aunque
    // la fase fuera la misma.
    if (!faseDibujandoRef.current) {
      faseDibujandoRef.current = true;
      seguidorRef.current?.cambiarFase('dibujando', `${listos} de ${total} imágenes`);
    } else {
      seguidorRef.current?.fijarDetalle(`${listos} de ${total} imágenes`);
    }
  }, []);

  const alRefinar = useCallback((activo: boolean, aAfinar: number, aTraer: number) => {
    setRefinando(activo ? { afinar: aAfinar, traer: aTraer } : { afinar: 0, traer: 0 });
  }, []);

  // El peso REAL de lo que se va a bajar. El documento declara el de todos los
  // recursos colocados —250 MB en el mas pesado— pero solo viajan los que se
  // ven: ~11 MB. Con el numero declarado, la barra mostraba 3% y "faltan 14
  // min" en una apertura de 50 s, y el usuario cerraba la app.
  const alPreverBytes = useCallback((bytes: number) => {
    seguidorRef.current?.fijarEsperados(bytes);
  }, []);

  // Antes este callback descartaba la vista previa apenas el usuario tocaba
  // el lienzo, sin importar cuanto se hubiera cargado -- un toque accidental
  // al 3% dejaba 18 huecos negros visibles el resto de la apertura. Ahora el
  // unico criterio es la cobertura (ver `alCoberturaLista`) o el techo de
  // espera; el toque en si ya no decide nada. Se deja de pasar el prop al
  // Viewer.
  const alFallar = useCallback((cuantos: number) => setFallidos(cuantos), []);

  // Avisos no bloqueantes del export ("lienzo vacio", "se recorto la
  // resolucion"). Antes el primero era un alert() -- congelaba TODO,
  // incluido el render loop del canvas -- y el segundo solo iba a la
  // consola. Se auto-oculta: es feedback de un click puntual, no un estado
  // persistente del documento (a diferencia de `fallidos`, que si lo es).
  // Que formato se esta exportando ahora mismo (o null). Antes los tres
  // botones quedaban clickeables durante todo el export -- un doble click en
  // "PDF" disparaba DOS exports en paralelo, cada uno rasterizando de nuevo
  // los mismos recursos a resolucion de papel, y no habia ninguna señal de
  // que el primer click ya habia hecho algo (el archivo tarda varios
  // segundos en generarse, sobre todo con PDFs pesados).
  const [exportando, setExportando] = useState<'pdf' | 'jpg' | 'png' | null>(null);
  const ejecutarExport = useCallback(async (formato: 'pdf' | 'jpg' | 'png') => {
    if (exportando) return;
    setExportando(formato);
    try {
      await viewerRef.current?.exportDrawing(formato, exportZoomAll);
      logDescarga('lienzo', formato, [], fileName);
    } finally {
      setExportando(null);
    }
  }, [exportando, exportZoomAll, fileName]);

  const [exportAviso, setExportAviso] = useState<string | null>(null);
  const exportAvisoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alExportNotice = useCallback((mensaje: string) => {
    setExportAviso(mensaje);
    if (exportAvisoTimerRef.current) clearTimeout(exportAvisoTimerRef.current);
    exportAvisoTimerRef.current = setTimeout(() => setExportAviso(null), 5000);
  }, []);

  // useCallback con identidad estable: son props de `LayerMenu`/`ImageMenu`
  // (memoizados, ver sus comentarios), asi que si estos fueran arrows
  // nuevas en cada render de `ConceptViewer` el memo no serviria de nada.
  const toggleLayerVisibility = useCallback((id: string) => {
    setLayerConfigs(prev => ({
      ...prev,
      [id]: { ...prev[id], visible: !prev[id]?.visible }
    }));
  }, []);

  const setLayerOpacity = useCallback((id: string, opacity: number) => {
    setLayerConfigs(prev => ({
      ...prev,
      [id]: { ...prev[id], opacity }
    }));
  }, []);

  const toggleIsolate = useCallback((id: string) => {
    setIsolatedLayer(prev => prev === id ? null : id);
  }, []);

  const toggleLayerMenuOpen = useCallback(() => {
    setShowLayerMenu(v => !v);
    setShowImageMenu(false);
  }, []);

  const toggleImageMenuOpen = useCallback(() => {
    setShowImageMenu(abriendo => {
      const next = !abriendo;
      setShowLayerMenu(false);
      // Las previews se generan recien aca: es un loop de toDataURL en el
      // hilo principal que en gama baja cuesta cientos de ms, y la mayoria
      // de los usuarios nunca abre este menu. Se piden en CADA apertura (no
      // una sola vez por documento): las fotos que llegaron despues de la
      // primera vez nunca aparecian.
      if (next) void (window as any).__conceptsPedirPreviews?.();
      return next;
    });
  }, []);

  const resetLayers = useCallback(() => {
    setLayerConfigs(prev => {
      const next: Record<string, LayerConfig> = {};
      Object.keys(prev).forEach(k => { next[k] = { ...prev[k], visible: true, opacity: 1.0 }; });
      return next;
    });
    setIsolatedLayer(null);
  }, []);

  const toggleAllLayersVisible = useCallback(() => {
    setLayerConfigs(prev => {
      const allVisible = Object.values(prev).every(c => c.visible);
      const next: Record<string, LayerConfig> = {};
      Object.keys(prev).forEach(k => { next[k] = { ...prev[k], visible: !allVisible }; });
      return next;
    });
  }, []);

  if (error) {
    return (
      <div className="app-container">
        <div className="error-state">
          <h3>No se pudo abrir el dibujo</h3>
          <p>{error}</p>
          {/* El codigo es lo que la persona manda por WhatsApp; sin el, un
              "no se pudo abrir" no dice nada para buscar en la tabla. */}
          {errorCodigo && (
            <p style={{ fontSize: '0.8rem', opacity: 0.7 }}>Código: {errorCodigo}</p>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
            <button className="btn" onClick={() => setIntentoReintento((n) => n + 1)}>
              Reintentar
            </button>
            <button className="btn" onClick={onClose}>Cerrar</button>
          </div>
        </div>
      </div>
    );
  }

  if (!doc || !stats) {
    // Mientras se decodifica el documento se muestra la vista previa que trae
    // el propio archivo: el usuario reconoce su dibujo de inmediato en vez de
    // mirar un spinner sobre fondo vacio.
    return (
      <div className="app-container">
        <div className="filename-display">{fileName.replace('.concepts', '')}</div>
        <button className="btn-close-viewer" onClick={onClose} title="Cerrar documento">
          <X size={20} />
        </button>
        <div className="viewer-placeholder">
          {placeholder && <img src={placeholder} alt="" className="viewer-placeholder-img" />}
          <BarraCarga progreso={progreso} />
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="filename-display">
        {fileName.replace('.concepts', '')}
      </div>

      {/* Top Right: Close Button */}
      <button className="btn-close-viewer" onClick={onClose} title="Cerrar documento">
        <X size={20} />
      </button>

      {/* Bottom Right: Tools */}
      <div className="floating-tools">
        {/* Encuadrar todo: vuelve a la vista completa del dibujo despues de
            haberse acercado. Mismo estilo que el resto de las herramientas. */}
        <button
          className="btn-tool"
          onClick={() => viewerRef.current?.zoomAll()}
          title="Ver todo el dibujo"
          aria-label="Ver todo el dibujo"
        >
          <Maximize2 size={20} />
        </button>

        <button
          className="btn-tool"
          onClick={() => viewerRef.current?.zoomIn()}
          title="Acercar"
          aria-label="Acercar"
        >
          <ZoomIn size={20} />
        </button>

        <button
          className="btn-tool"
          onClick={() => viewerRef.current?.zoomOut()}
          title="Alejar"
          aria-label="Alejar"
        >
          <ZoomOut size={20} />
        </button>

        <button
          className="btn-tool"
          onClick={alternarFullscreen}
          title={enFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
          aria-label={enFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
        >
          {enFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
        </button>

        <button
          className="btn-tool"
          onClick={alternarTemaViewer}
          title={tema === 'oscuro' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
          aria-label={tema === 'oscuro' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
        >
          {tema === 'oscuro' ? <Sun size={20} /> : <Moon size={20} />}
        </button>

        {/* Copiar enlace: solo tiene sentido para un dibujo de la galeria
            (Drive), que es lo unico que deja una URL compartible -- un
            archivo subido a mano (`source.kind === 'local'`) no tiene de
            donde volver a abrirse, asi que el boton ni aparece. */}
        {source.kind === 'remote' && (
          <button
            className="btn-tool"
            onClick={copiarEnlace}
            title={enlaceCopiado ? 'Enlace copiado' : 'Copiar enlace'}
            aria-label={enlaceCopiado ? 'Enlace copiado' : 'Copiar enlace'}
          >
            {enlaceCopiado ? <Check size={20} /> : <Link2 size={20} />}
          </button>
        )}

        <div className="dropdown-container" ref={atajosMenuRef}>
          <button
            className={`btn-tool ${showAtajos ? 'active-glow' : ''}`}
            onClick={() => setShowAtajos((v) => !v)}
            title="Atajos de teclado"
            aria-label="Atajos de teclado"
          >
            <Keyboard size={20} />
          </button>
          {showAtajos && (
            <div className="dropdown-menu atajos-menu">
              <div className="layer-menu-header">
                <span>Atajos de teclado</span>
              </div>
              <ul className="atajos-lista">
                <li><kbd>+</kbd> / <kbd>-</kbd><span>Acercar / alejar</span></li>
                <li><kbd>0</kbd><span>Ver todo el dibujo</span></li>
                <li><kbd>[</kbd> / <kbd>]</kbd><span>Plano anterior / siguiente</span></li>
                <li><kbd>F</kbd><span>Pantalla completa</span></li>
                <li><kbd>Esc</kbd><span>Cerrar menus / foto</span></li>
                <li><kbd>?</kbd><span>Mostrar esta ayuda</span></li>
              </ul>
            </div>
          )}
        </div>

        <div className="dropdown-container" ref={exportMenuRef}>
          <button
            className={`btn-tool ${showExportMenu ? 'active-glow' : ''}`}
            onClick={() => { setShowExportMenu(!showExportMenu); setShowLayerMenu(false); setShowImageMenu(false); }}
            title="Exportar"
            aria-label="Exportar"
          >
            <Download size={20} />
          </button>
          
          {showExportMenu && (
            <div className="dropdown-menu" style={{ minWidth: '150px' }}>
              <div className="layer-menu-header">
                <span>Exportar</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', padding: '0.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', marginBottom: '8px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={exportZoomAll} onChange={(e) => setExportZoomAll(e.target.checked)} />
                  Completo
                </label>
                <button className="btn btn-tiny" style={{ marginBottom: '4px', padding: '8px' }} disabled={!!exportando} onClick={() => ejecutarExport('pdf')}>
                  {exportando === 'pdf' ? 'Exportando…' : '📄 PDF'}
                </button>
                <button className="btn btn-tiny" style={{ marginBottom: '4px', padding: '8px' }} disabled={!!exportando} onClick={() => ejecutarExport('jpg')}>
                  {exportando === 'jpg' ? 'Exportando…' : '🖼 JPG'}
                </button>
                <button className="btn btn-tiny" style={{ padding: '8px' }} disabled={!!exportando} onClick={() => ejecutarExport('png')}>
                  {exportando === 'png' ? 'Exportando…' : '💠 PNG'}
                </button>
              </div>
            </div>
          )}
        </div>

        <LayerMenu
          layers={doc.layers}
          layerConfigs={layerConfigs}
          isolatedLayer={isolatedLayer}
          open={showLayerMenu}
          layerCount={stats.layers}
          menuRef={layerMenuRef}
          onToggleOpen={toggleLayerMenuOpen}
          onSetOpacity={setLayerOpacity}
          onToggleVisibility={toggleLayerVisibility}
          onToggleIsolate={toggleIsolate}
          onReset={resetLayers}
          onToggleAll={toggleAllLayersVisible}
        />

        <ImageMenu
          open={showImageMenu}
          imageCount={stats.images}
          resourceIds={doc.resourceIds}
          imageUrls={imageUrls}
          menuRef={imageMenuRef}
          onToggleOpen={toggleImageMenuOpen}
          onOpenPhoto={abrirFoto}
        />
      </div>

      {/* Navegacion entre planos: barra propia, separada del stack vertical
          de herramientas (antes vivia ahi adentro y era parte de por que
          esa columna se quedaba sin lugar en pantalla). */}
      {stats.images > 1 && (
        <div className="plano-nav-bar">
          <button
            className="plano-nav-btn"
            onClick={() => irAPlano(-1)}
            title="Plano anterior ([)"
            aria-label="Plano anterior"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="plano-nav-indicador" aria-live="polite">
            {planoActual + 1}/{stats.images}
          </span>
          <button
            className="plano-nav-btn"
            onClick={() => irAPlano(1)}
            title="Plano siguiente (])"
            aria-label="Plano siguiente"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {/* Opacidad de las imagenes: antes vivia adentro del desplegable de
          "Imagenes" (habia que abrirlo para encontrarla); ahora es su propia
          barra fija abajo a la izquierda, siempre a mano. */}
      {stats.images > 0 && (
        <div className="opacidad-bar" title="Opacidad de las imágenes">
          <ImageIcon size={16} />
          <input
            type="range"
            min="0" max="1" step="0.05"
            value={imageOpacity}
            onChange={(e) => setImageOpacity(parseFloat(e.target.value))}
            className="opacidad-slider"
            aria-label="Opacidad de las imágenes"
          />
          <span className="opacidad-valor">{Math.round(imageOpacity * 100)}%</span>
        </div>
      )}

      <main className="main-content">
        <div className="canvas-wrapper">
          <Viewer
            ref={viewerRef}
            doc={doc}
            fileId={fileId}
            layerConfigs={layerConfigs}
            isolatedLayer={isolatedLayer}
            imageOpacity={imageOpacity}
            onImagesLoaded={alCargarImagenes}
            onResourcesReady={alTerminarRecursos}
            onResourceProgress={alAvanzarRecursos}
            onRefinando={alRefinar}
            onBytesPrevistos={alPreverBytes}
            onFallidos={alFallar}
            onCoberturaLista={alCoberturaLista}
            onExportNotice={alExportNotice}
          />
          {/* Al acercarse, los planos se vuelven a rasterizar a mas resolucion.
              Mientras tanto se sigue viendo la version anterior, y sin avisar
              eso se lee como "quedo borroso" en vez de "esta afinando". */}
          {recursosListos && (refinando.afinar > 0 || refinando.traer > 0) && (
            <div className="viewer-refinando">
              <span className="viewer-loading-dot" />
              {refinando.traer > 0
                ? `Trayendo ${refinando.traer} plano${refinando.traer === 1 ? '' : 's'}…`
                : `Afinando ${refinando.afinar} plano${refinando.afinar === 1 ? '' : 's'}…`}
            </div>
          )}
          {/* La vista previa se mantiene hasta que TODO lo que cae en el
              viewport ya tiene bitmap real (`previaDescartada`, disparado por
              `onCoberturaLista` del Viewer o por el techo de espera de mas
              arriba) -- NO hasta que aparece la primera imagen. En estos
              dibujos los trazos son anotaciones finas sobre los planos, asi
              que mostrar solo los trazos daba un lienzo practicamente vacio
              durante toda la carga de las fotos (medido: ~28 s en el dibujo
              de 262 MB). Antes se retiraba con el PRIMER recurso, dejando ver
              el resto como huecos casi negros el resto de la carga: el
              objetivo es que nunca se vea nada a medio cargar, asi que se
              tapa todo hasta que reemplazarlo no deja huecos. */}
          {/* Un plano que no se pudo traer se dice, no se esconde: antes la
              app afirmaba "listo" con recuadros vacios y sin ninguna pista de
              que faltaba algo ni de por que. */}
          {fallidos > 0 && (
            <div className="viewer-fallidos" role="status">
              {fallidos} plano{fallidos === 1 ? '' : 's'} no se pudo cargar
            </div>
          )}
          {exportAviso && (
            <div className="viewer-export-aviso" role="status" onClick={() => setExportAviso(null)}>
              {exportAviso}
            </div>
          )}
          {placeholder && doc.resourceIds.length > 0 && !recursosListos && !previaDescartada && (
            <div className="viewer-placeholder viewer-placeholder-overlay">
              <img src={placeholder} alt="" className="viewer-placeholder-img" />
            </div>
          )}
          {!recursosListos && doc.resourceIds.length > 0 && <BarraCarga progreso={progreso} />}
        </div>

        {previewImage && previewPhotoId && (
          <InteractivePreview
            src={previewImage}
            photoId={previewPhotoId}
            fileName={fileName}
            loadingFull={previewLoadingFull}
            onClose={cerrarFoto}
          />
        )}
      </main>
    </div>
  );
}

export default ConceptViewer;
