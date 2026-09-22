import { useEffect, useState } from 'react';
import { contexto, volver } from './lib/centinela';
import './PortalVolver.css';

/**
 * Renglon delgado "‹ Volver | Concept", visible SOLO cuando esta app corre
 * embebida en el iframe del Portal (babelbim.com/#concept). Fuera de ahi
 * (dominio de Vercel directo) no existe: no hay a donde volver. Sin version:
 * ya la muestra la chapita del gateway (insignia.ts) en todas las apps, y
 * mostrarla dos veces -- ademas de redundante -- competia por el mismo
 * lugar (ver el `margin-top` en PortalVolver.css).
 *
 * A diferencia de W_14_Admin (que lo pinta dentro de su propia `.cabecera`
 * sticky), esta app no tiene una barra de titulo compartida entre la galeria
 * y el visor de planos: `.gallery-header` (Gallery.tsx) se oculta en cuanto
 * hay un dibujo abierto, y el visor no tiene cabecera propia. Por eso este
 * componente vive a nivel de App.tsx, fuera de ambos arboles, como un
 * renglon propio en flujo normal (no flotante: antes era un chip
 * `position: fixed` que tapaba el titulo de la galeria y el nombre de
 * archivo del visor, ambos arriba a la izquierda -- ver PortalVolver.css).
 *
 * `position: relative` + z-index alto (no `fixed`): sigue empujando a
 * `.gallery-page` hacia abajo en el flujo normal del documento (por eso no
 * hace falta tocar Gallery.css), y a la vez se pinta por encima de
 * `.viewer-hero`/`.fullscreen-preview`, que SI son `fixed` y por eso no
 * respetan el flujo. Para que el visor de dibujos (igual de `fixed`) deje el
 * mismo lugar libre arriba, este componente escribe la altura real en
 * `--cabecera-embebida-h` (leida por `.viewer-hero`, ver index.css).
 *
 * Deteccion de contexto: preferimos `UnxCentinela.contexto === 'iframe'`
 * (gateway, via Sec-Fetch-Dest); sin centinela (kill switch, o esta pagina
 * abierta fuera del gateway) caemos a `window.self !== window.top`, mismo
 * criterio que usa Admin en su pantalla de fallback.
 */
export function PortalVolver() {
  const [embebido, setEmbebido] = useState(false);

  useEffect(() => {
    const c = contexto();
    let esEmbebido: boolean;
    if (c) {
      esEmbebido = c === 'iframe';
    } else {
      try {
        esEmbebido = window.self !== window.top;
      } catch {
        // Un acceso a `window.top` que tira SecurityError solo pasa cuando el
        // origen del padre es distinto: eso ES estar embebido.
        esEmbebido = true;
      }
    }
    setEmbebido(esEmbebido);
    if (!esEmbebido) return;

    document.documentElement.classList.add('con-cabecera-embebida');
    return () => {
      document.documentElement.classList.remove('con-cabecera-embebida');
    };
  }, []);

  if (!embebido) return null;

  return (
    <PortalVolverBar />
  );
}

function PortalVolverBar() {
  // Distancia real hasta el borde inferior publicada en --cabecera-embebida-h
  // (index.css) para que .viewer-hero, que es `fixed` y por eso ignora el
  // flujo normal, deje exactamente ese mismo espacio libre arriba.
  // getBoundingClientRect().bottom (no offsetHeight): este renglon es el
  // primer elemento de la pagina y lleva `margin-top` para no quedar bajo la
  // chapita de version del gateway (ver PortalVolver.css) -- offsetHeight
  // ignora ese margen y el visor de dibujos quedaria empezando mas arriba de
  // lo que el renglon en verdad ocupa.
  const medirAltura = (el: HTMLElement | null) => {
    if (!el) return;
    document.documentElement.style.setProperty('--cabecera-embebida-h', `${el.getBoundingClientRect().bottom}px`);
  };

  return (
    <header className="cabecera-embebida" ref={medirAltura}>
      <button type="button" className="cabecera-embebida-volver" onClick={volver} title="Volver al portal">
        ‹ Volver
      </button>
      <span className="cabecera-embebida-nombre">Concept</span>
    </header>
  );
}
