import React, { useRef, useState, useEffect } from 'react';
import { Download, RotateCw } from 'lucide-react';
import { logDescarga } from '../Gallery/analytics';
import { safeExportScale } from '../Gallery/renderCore';

interface InteractivePreviewProps {
  src: string;
  /**
   * Identidad ESTABLE de la foto (el resourceId), distinta de `src`.
   *
   * `src` cambia DOS veces por foto: primero la miniatura chica (ya
   * cacheada), despues la version completa sin recortar (`obtenerImagenCompleta`
   * en Viewer.tsx). Antes el efecto que calcula rotacion/zoom/pan escuchaba
   * cambios en `src` directamente, asi que ese segundo cambio (misma foto,
   * mejor resolucion) TAMBIEN reseteaba todo: la foto se des-rotaba y se
   * volvia a rotar con un salto visible, y cualquier zoom/pan que el
   * usuario hubiera hecho mientras esperaba se tiraba a la basura. Con
   * `photoId` estable entre esas dos cargas, el reset solo ocurre cuando de
   * verdad se abre una foto DISTINTA.
   */
  photoId: string;
  fileName?: string;
  onClose: () => void;
  /** true mientras se pide la version completa sin recortar (ver
   * `abrirFoto` en App.tsx): `src` todavia es la miniatura chica de la
   * galeria. Se muestra un cartel chico en vez de dejar que el usuario crea
   * que la carga se colgo. */
  loadingFull?: boolean;
}

export const InteractivePreview: React.FC<InteractivePreviewProps> = ({ src, photoId, fileName, onClose, loadingFull }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [isRightDragging, setIsRightDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [rightDragStartPos, setRightDragStartPos] = useState({ x: 0, y: 0 });
  const [dragStartZoom, setDragStartZoom] = useState(1);
  const [dragStartPan, setDragStartPan] = useState({ x: 0, y: 0 });
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportZoomAll, setExportZoomAll] = useState(true);
  // Rotacion manual de la foto en pantalla (0/90/180/270), a pedido del
  // usuario: algunas fotos vienen embebidas de costado o cabeza abajo (la
  // rotacion viene del propio archivo .concepts) y no hay forma de arreglarlo
  // desde ahi. Se resetea al abrir una foto distinta.
  const [rotacion, setRotacion] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);

  /**
   * Relacion de lados a partir de la cual una imagen se considera una TIRA:
   * un plano largo y angosto, no una foto. Los de esta carpeta son 1:4,7.
   */
  const RELACION_TIRA = 4;

  /**
   * Gira sola las tiras que entran cruzadas respecto de la pantalla.
   *
   * Un plano de 1:4,7 abierto en vertical sobre una pantalla apaisada usa una
   * franja finita en el medio y deja el resto vacio: hay que rotarlo a mano
   * para poder leerlo, todas las veces. Con la relacion 1:4 como corte, girarlo
   * es lo que el usuario iba a hacer igual.
   *
   * Solo cuando esta CRUZADO (tira vertical en pantalla apaisada, o al reves):
   * si la tira ya coincide con la orientacion de la pantalla, rotarla seria
   * justamente lo contrario de lo que conviene. Se puede deshacer con el boton
   * de rotar o con la tecla R, y se recalcula al abrir otra foto.
   */
  const rotacionInicial = (img: HTMLImageElement | null) => {
    const w = img?.naturalWidth ?? 0;
    const h = img?.naturalHeight ?? 0;
    if (!w || !h) return 0;
    const esTira = Math.max(w, h) / Math.min(w, h) >= RELACION_TIRA;
    if (!esTira) return 0;
    const imagenVertical = h > w;
    const pantallaApaisada = window.innerWidth >= window.innerHeight;
    return imagenVertical === pantallaApaisada ? 90 : 0;
  };

  // La decision NO puede colgar solo de `onLoad`: si la imagen ya esta en el
  // cache del navegador (abrir la misma foto dos veces, o el data URL que ya
  // se mostro como miniatura) la carga termina antes de que React enganche el
  // handler y el evento no llega nunca — se probo en movil y la tira se abria
  // sin girar. Se mira tambien al montar y en cada cambio de `src`.
  /**
   * Encuadra la foto para la rotacion dada: la agranda hasta llenar la
   * pantalla y la centra.
   *
   * Hace falta porque el `<img>` se dimensiona por CSS (`max-width`/
   * `max-height`) SIN saber de la rotacion: girado un cuarto de vuelta, el
   * elemento conserva su caja original y una tira apaisada de 720x153
   * terminaba ocupando 153 de ancho y 720 de alto — mas chica todavia que
   * antes de girar. Justo lo contrario de para lo que se gira.
   */
  const encuadrar = (rot: number) => {
    const img = imgRef.current;
    const cont = containerRef.current;
    if (!img || !cont || !img.clientWidth || !img.clientHeight) return;
    const girada = ((rot % 180) + 180) % 180 !== 0;
    const cajaW = girada ? img.clientHeight : img.clientWidth;
    const cajaH = girada ? img.clientWidth : img.clientHeight;
    // Un respiro contra los bordes, del mismo orden que el padding de la vista.
    const dispW = cont.clientWidth - 32;
    const dispH = cont.clientHeight - 32;
    if (cajaW <= 0 || cajaH <= 0 || dispW <= 0 || dispH <= 0) return;
    setZoom(Math.min(dispW / cajaW, dispH / cajaH));
    setPan({ x: 0, y: 0 });
  };

  const rotar = () => {
    setRotacion((r) => {
      const siguiente = (r + 90) % 360;
      encuadrar(siguiente);
      return siguiente;
    });
  };

  const evaluarRotacion = () => {
    const rot = rotacionInicial(imgRef.current);
    setRotacion(rot);
    encuadrar(rot);
  };

  /** Ultimo `photoId` para el que ya se corrio `evaluarRotacion`. Evita
   * repetirla cuando `src` cambia por la miniatura->version completa de la
   * MISMA foto (ver el comentario largo en `photoId` mas arriba). */
  const photoIdEvaluadoRef = useRef<string | null>(null);

  useEffect(() => {
    if (photoIdEvaluadoRef.current === photoId) return;
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth) {
      photoIdEvaluadoRef.current = photoId;
      evaluarRotacion();
    } else {
      // Todavia no se sabe la forma real de la imagen: se resuelve cuando
      // termine de cargar (ver `onLoad` en el <img>, mas abajo).
      setRotacion(0);
    }
    // `rotacionInicial` solo lee el DOM y el tamaño de la ventana; recrearla
    // en cada render no cambia lo que decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoId]);

  /** Handler de `onLoad` del <img>: mismo criterio que el efecto de arriba,
   * para no re-evaluar cuando lo que cargo es la version de mas resolucion
   * de la foto que ya se estaba mostrando. */
  const alCargarImagen = () => {
    if (photoIdEvaluadoRef.current === photoId) return;
    photoIdEvaluadoRef.current = photoId;
    evaluarRotacion();
  };

  const exportDrawing = async (format: 'png' | 'jpg' | 'pdf', zoomAll: boolean = true) => {
    const img = new Image();
    img.src = src;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      // Sin esto, si la imagen fallaba al cargar la promesa nunca resolvia
      // NI rechazaba: el export quedaba colgado sin ningun feedback, con el
      // menu abierto para siempre y sin ningun error en consola que
      // explicara por que.
      img.onerror = () => reject(new Error("No se pudo cargar la imagen para exportar"));
      if (img.complete) resolve(true);
    });

    let exportWidth, exportHeight;
    let translateX, translateY, exportZoom;

    if (zoomAll) {
      // Girada un cuarto de vuelta (90/270), la caja del export se planta
      // con los lados intercambiados: si no, una foto rotada a apaisada se
      // exporta recortada dentro de un lienzo vertical. `% 180` en vez de
      // comparar contra 90/270 a mano: sigue valiendo si el control de
      // rotacion deja de moverse en pasos fijos de 90°.
      const girada90 = ((rotacion % 180) + 180) % 180 !== 0;
      exportWidth = girada90 ? img.naturalHeight : img.naturalWidth;
      exportHeight = girada90 ? img.naturalWidth : img.naturalHeight;
      translateX = exportWidth / 2;
      translateY = exportHeight / 2;
      exportZoom = 1;
    } else {
      const rect = containerRef.current?.getBoundingClientRect();
      exportWidth = rect ? rect.width : window.innerWidth;
      exportHeight = rect ? rect.height : window.innerHeight;
      translateX = exportWidth / 2 + pan.x;
      translateY = exportHeight / 2 + pan.y;
      exportZoom = zoom;
    }

    // safeExportScale (no EXPORT_SCALE crudo): una foto grande, mas si esta
    // rotada 90/270, puede pasarse del limite duro de canvas del navegador
    // (queda en blanco, sin error) o del presupuesto de RAM del dispositivo.
    // Es el mismo criterio que ya usan el export del visor y el de la
    // galeria — este era el unico camino de export que no lo aplicaba.
    const scale = safeExportScale(exportWidth, exportHeight);
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = Math.round(exportWidth * scale);
    exportCanvas.height = Math.round(exportHeight * scale);
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (format === 'jpg' || format === 'pdf') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    }

    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(translateX, translateY);
    ctx.scale(exportZoom, exportZoom);
    if (rotacion) ctx.rotate((rotacion * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    ctx.restore();

    // toBlob (async) en vez de toDataURL (sincronico): a la escala de export
    // esto puede ser un canvas de varios Mpx, y toDataURL bloquea el hilo
    // principal codificando JPEG/PNG entero antes de devolver el control.
    const mime = `image/${format === 'jpg' ? 'jpeg' : 'png'}`;
    const blob = await new Promise<Blob | null>((resolve) => exportCanvas.toBlob(resolve, mime, 1.0));
    exportCanvas.width = 0;
    exportCanvas.height = 0;
    if (!blob) throw new Error("No se pudo generar la exportacion");

    if (format === 'pdf') {
      // jsPDF no acepta Blob en addImage: hace falta el data URL, pero solo
      // ACA, uno a la vez, no desde el arranque.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el blob"));
        reader.readAsDataURL(blob);
      });
      const jsPDF = (await import('jspdf')).default;
      const pdf = new jsPDF({
        orientation: exportWidth > exportHeight ? 'landscape' : 'portrait',
        unit: 'px',
        format: [exportWidth, exportHeight]
      });
      pdf.addImage(dataUrl, 'JPEG', 0, 0, exportWidth, exportHeight);
      pdf.save('export.pdf');
    } else {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `export.${format}`;
      link.href = url;
      // Mismo motivo que en exportRender.ts: revocar el ObjectURL
      // inmediatamente tras click() es una carrera conocida en Safari/
      // Firefox moviles (la descarga puede fallar o salir truncada, sin
      // error). Se agrega al DOM (Firefox lo requiere para ser confiable) y
      // se revoca diferido.
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        link.remove();
        URL.revokeObjectURL(url);
      }, 60_000);
    }
    logDescarga('foto', format, [], fileName);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
      // R para rotar, el mismo cuarto de vuelta que el boton. Se ignora si el
      // foco esta en un campo de texto (hoy no hay ninguno en esta vista, pero
      // escribir una "r" y que la foto gire seria de lo mas desconcertante).
      if (e.key === 'r' || e.key === 'R') {
        const el = document.activeElement as HTMLElement | null;
        const escribiendo =
          !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (escribiendo || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        rotar();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Mismo patron que Viewer.tsx: un listener nativo no pasivo solo para
  // bloquear el scroll de la pagina detras del visor mientras se hace zoom
  // con la rueda. Sin esto, la pagina se corria hacia abajo/arriba de fondo
  // mientras la foto zoomeaba, un bug que ya estaba arreglado en el visor
  // principal pero no en esta vista.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const bloquear = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', bloquear, { passive: false });
    return () => el.removeEventListener('wheel', bloquear);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
       setIsRightDragging(true);
       setRightDragStartPos({ x: e.clientX, y: e.clientY });
       setDragStartZoom(zoom);
       setDragStartPan(pan);
    } else if (e.button === 0) {
       // Only start dragging if we clicked the container, or we want to allow dragging everywhere
       setIsDragging(true);
       setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isRightDragging) {
       const totalDx = e.clientX - rightDragStartPos.x;
       const totalDy = e.clientY - rightDragStartPos.y;
       
       const distance = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
       const sign = (totalDx - totalDy) >= 0 ? 1 : -1;
       const zoomDelta = sign * distance; 
       const zoomFactor = Math.exp(zoomDelta * 0.015);
       let newZoom = dragStartZoom * zoomFactor;
       newZoom = Math.max(0.01, Math.min(newZoom, 100));

       const rect = containerRef.current?.getBoundingClientRect();
       if (!rect) return;
       const screenX = rightDragStartPos.x - rect.left;
       const screenY = rightDragStartPos.y - rect.top;

       const centerX = screenX - rect.width / 2;
       const centerY = screenY - rect.height / 2;

       const newPanX = centerX - (centerX - dragStartPan.x) * (newZoom / dragStartZoom);
       const newPanY = centerY - (centerY - dragStartPan.y) * (newZoom / dragStartZoom);

       setZoom(newZoom);
       setPan({ x: newPanX, y: newPanY });

    } else if (isDragging) {
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (e.button === 2) setIsRightDragging(false);
    if (e.button === 0) setIsDragging(false);
  };

  // OJO: aca NO se llama a e.preventDefault(). React adjunta `onWheel` como
  // listener PASIVO, asi que preventDefault no solo no hace nada: el
  // navegador lo reporta como error en consola en CADA paso de rueda
  // ("Unable to preventDefault inside passive event listener invocation"),
  // lo que llenaba la consola de ruido y tapaba errores de verdad. El scroll
  // de fondo ya lo frena el listener nativo no pasivo de mas arriba, que
  // existe justamente para eso.
  const handleWheel = (e: React.WheelEvent) => {
    const zoomFactor = 1.1;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = Math.pow(zoomFactor, direction);
    
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    
    const centerX = screenX - rect.width / 2;
    const centerY = screenY - rect.height / 2;
    
    let newZoom = zoom * factor;
    newZoom = Math.max(0.01, Math.min(newZoom, 100));

    const newPanX = centerX - (centerX - pan.x) * (newZoom / zoom);
    const newPanY = centerY - (centerY - pan.y) * (newZoom / zoom);

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  const [touchDistStart, setTouchDistStart] = useState<number | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      setIsDragging(true);
      setDragStart({ x: e.touches[0].clientX - pan.x, y: e.touches[0].clientY - pan.y });
    } else if (e.touches.length === 2) {
      setIsDragging(false);
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      setTouchDistStart(Math.sqrt(dx * dx + dy * dy));
      setDragStartZoom(zoom);
      setDragStartPan(pan);
      
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      setRightDragStartPos({ x: cx, y: cy });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && isDragging) {
      setPan({
        x: e.touches[0].clientX - dragStart.x,
        y: e.touches[0].clientY - dragStart.y,
      });
    } else if (e.touches.length === 2 && touchDistStart !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDist = Math.sqrt(dx * dx + dy * dy);
      
      const zoomFactor = currentDist / touchDistStart;
      let newZoom = dragStartZoom * zoomFactor;
      newZoom = Math.max(0.01, Math.min(newZoom, 100));

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const screenX = rightDragStartPos.x - rect.left;
      const screenY = rightDragStartPos.y - rect.top;

      const centerX = screenX - rect.width / 2;
      const centerY = screenY - rect.height / 2;

      const newPanX = centerX - (centerX - dragStartPan.x) * (newZoom / dragStartZoom);
      const newPanY = centerY - (centerY - dragStartPan.y) * (newZoom / dragStartZoom);

      setZoom(newZoom);
      setPan({ x: newPanX, y: newPanY });
    }
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    setTouchDistStart(null);
  };

  // Un solo layout sincronico por render (no dos): antes el indicador de
  // zoom de mas abajo llamaba a `getBoundingClientRect()` una vez para
  // `left` y otra para `top`, en cada frame que dura el pinch/arrastre con
  // boton derecho. Solo hace falta calcularlo cuando el indicador va a
  // mostrarse.
  const rectIndicadorZoom = isRightDragging ? containerRef.current?.getBoundingClientRect() : null;

  return (
    <div
      ref={containerRef}
      className="fullscreen-preview"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
         if (e.target === e.currentTarget) {
            onClose();
         }
      }}
      style={{
         cursor: isDragging ? "grabbing" : (isRightDragging ? "ns-resize" : "grab"),
         display: 'block',
         padding: 0,
         overflow: 'hidden',
         touchAction: "none"
      }}
    >
      <div 
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom}) rotate(${rotacion}deg)`,
          transformOrigin: 'center center',
          // `touchDistStart !== null`: durante un pinch de 2 dedos,
          // `handleTouchStart` pone `isDragging` en false (correcto, no es
          // un pan de 1 dedo) pero `isRightDragging` es EXCLUSIVO del
          // arrastre con boton derecho del mouse -- nunca se activa en
          // tactil. Sin este chequeo, ninguna de las dos condiciones era
          // cierta durante un pinch y la transicion de 0.1s quedaba activa,
          // animando cada frame del gesto: se sentia gomoso y con
          // retraso perceptible. `touchDistStart` ya es exactamente la
          // señal de "hay un pinch en curso" (se pone al iniciar uno, se
          // limpia en `handleTouchEnd`).
          transition: isDragging || isRightDragging || touchDistStart !== null ? 'none' : 'transform 0.1s ease',
        }}
      >
        <img 
           src={src} 
           alt="Preview" 
           ref={imgRef}
           onLoad={alCargarImagen}
           style={{ pointerEvents: 'none', userSelect: 'none', display: 'block' }}
           draggable={false}
        />
      </div>
      
      {/* Zoom Reference Indicator */}
      {isRightDragging && (
        <div style={{
          position: 'absolute',
          left: rightDragStartPos.x - (rectIndicadorZoom?.left ?? 0),
          top: rightDragStartPos.y - (rectIndicadorZoom?.top ?? 0),
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

      {/* Floating Tools exactly like Viewer */}
      <div className="floating-tools" style={{ zIndex: 10002 }}>
        <button
          className="btn-tool"
          onClick={(e) => { e.stopPropagation(); rotar(); }}
          title="Rotar 90° a la derecha (R)"
        >
          <RotateCw size={20} />
        </button>
        <div className="dropdown-container">
          <button
            className={`btn-tool ${showExportMenu ? 'active-glow' : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowExportMenu(!showExportMenu); }}
            title="Exportar"
          >
            <Download size={20} />
          </button>
          
          {showExportMenu && (
            <div className="dropdown-menu" style={{ minWidth: '150px' }} onClick={(e) => e.stopPropagation()}>
              <div className="layer-menu-header">
                <span>Exportar</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', padding: '0.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', marginBottom: '8px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={exportZoomAll} onChange={(e) => setExportZoomAll(e.target.checked)} />
                  Completo
                </label>
                <button className="btn btn-tiny" style={{ marginBottom: '4px', padding: '8px' }} onClick={() => exportDrawing('pdf', exportZoomAll)}>📄 PDF</button>
                <button className="btn btn-tiny" style={{ marginBottom: '4px', padding: '8px' }} onClick={() => exportDrawing('jpg', exportZoomAll)}>🖼 JPG</button>
                <button className="btn btn-tiny" style={{ padding: '8px' }} onClick={() => exportDrawing('png', exportZoomAll)}>💠 PNG</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          // env(safe-area-inset-*): sin esto, en un iPhone en landscape el
          // boton quedaba bajo el notch.
          top: 'calc(20px + env(safe-area-inset-top))',
          right: 'calc(20px + env(safe-area-inset-right))',
          zIndex: 10001, background: 'rgba(255,255,255,0.2)',
          border: 'none', color: 'white', padding: '8px 16px',
          borderRadius: '4px', cursor: 'pointer'
        }}
      >
        Cerrar (ESC)
      </button>

      {loadingFull && (
        <div
          style={{
            position: 'absolute', top: 'calc(20px + env(safe-area-inset-top))', left: '50%', transform: 'translateX(-50%)',
            zIndex: 10001, display: 'flex', alignItems: 'center', gap: '0.5rem',
            background: 'rgba(0,0,0,0.55)', color: 'white', padding: '0.4rem 0.9rem',
            borderRadius: '999px', fontSize: '0.8rem', pointerEvents: 'none',
          }}
        >
          <span
            style={{
              width: '8px', height: '8px', borderRadius: '50%', background: '#fff',
              animation: 'pulseDot 1s ease-in-out infinite',
            }}
          />
          Cargando full HD…
        </div>
      )}
    </div>
  );
};
