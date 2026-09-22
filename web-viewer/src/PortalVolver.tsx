import { useEffect, useState } from 'react';
import { contexto, volver } from './lib/centinela';
import './PortalVolver.css';

/**
 * Boton "‹ Volver" al Portal, visible SOLO cuando esta app corre embebida en
 * el iframe del Portal (babelbim.com/#concept). Fuera de ahi (dominio de
 * Vercel directo) no existe: no hay a donde volver.
 *
 * A diferencia de W_14_Admin (que lo pinta dentro de su propia `.cabecera`
 * sticky), esta app no tiene una barra de titulo compartida entre la galeria
 * y el visor de planos: `.gallery-header` (Gallery.tsx) se oculta en cuanto
 * hay un dibujo abierto, y el visor no tiene cabecera propia. Por eso este
 * componente vive a nivel de App.tsx, fuera de ambos arboles, como un chip
 * flotante `position: fixed` que queda por encima de las dos pantallas.
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
    if (c) {
      setEmbebido(c === 'iframe');
      return;
    }
    try {
      setEmbebido(window.self !== window.top);
    } catch {
      // Un acceso a `window.top` que tira SecurityError solo pasa cuando el
      // origen del padre es distinto: eso ES estar embebido.
      setEmbebido(true);
    }
  }, []);

  if (!embebido) return null;

  return (
    <button type="button" className="portal-volver" onClick={volver} title="Volver al portal">
      ‹ Volver
    </button>
  );
}
