/**
 * Rutas compartibles: la URL refleja donde estas.
 *
 *   /                                       -> galeria, carpeta raiz
 *   /Guada-y-Flor-Re/Concepts               -> galeria, dentro de esa carpeta
 *   /Guada-y-Flor-Re/Concepts/RO-3er-y-4to  -> ese dibujo abierto
 *
 * El slug se arma con el NOMBRE de cada carpeta/archivo, no con los ids de
 * Drive: un link tiene que decir a que plano apunta con solo mirarlo. La
 * contra es que hay que resolver el nombre contra el arbol de Drive al
 * entrar, pero ese arbol ya esta cacheado en Supabase y se trae entero en una
 * sola consulta, asi que resolver es instantaneo.
 *
 * Se usan segmentos separados por "/" (no un solo segmento con guiones) para
 * que los nombres que YA tienen guiones —abundan: "RO- 4to Piso"— no rompan
 * la ruta al volver a partirla.
 */

/**
 * El prefijo bajo el que se sirve la app. Tiene que coincidir con el `base` de
 * vite.config.ts y con el slug del gateway.
 *
 * Sin esto la app escribia "/" y "/carpeta/archivo" en la barra de
 * direcciones de babelbim.com, donde "/" es SIEMPRE el Portal: recargar
 * adentro de Concept --o mandarle el link a alguien-- te sacaba a la pantalla
 * de iconos. Y "/guada-y-flor-re" choca con el prefijo de cualquier otro
 * modulo que se llame parecido.
 */
export const BASE = "/concept";

/** Convierte un nombre a un segmento de URL legible y estable. */
export function aSlug(nombre: string): string {
  return (
    nombre
      .normalize("NFD")
      // Marcas de acento que deja NFD (ñ -> n, á -> a). Escapadas a proposito:
      // escritas literalmente son invisibles y cualquier editor las come.
      .replace(/[̀-ͯ]/g, "")
      .replace(/\.concepts$/i, "")
      .trim()
      .replace(/[^\w\s-]/g, "") // simbolos raros
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "sin-nombre"
  );
}

export function construirRuta(carpetas: string[], archivo?: string | null): string {
  const partes = carpetas.map(aSlug).filter(Boolean);
  if (archivo) partes.push(aSlug(archivo));
  return partes.length ? `${BASE}/${partes.join("/")}` : `${BASE}/`;
}

export interface RutaLeida {
  /** Slugs de las carpetas, sin contar la raiz. */
  carpetas: string[];
  /** Slug del archivo, si la ruta apunta a un dibujo. */
  archivo: string | null;
}

/** Lee la ruta actual. `archivo` se decide despues, comparando contra el
 * arbol: aca solo se parte en segmentos. */
export function leerRuta(pathname = window.location.pathname): string[] {
  const partes = pathname.split("/").map((s) => decodeURIComponent(s)).filter(Boolean);
  // Se saca el prefijo si esta. Se tolera que no este para que la app siga
  // andando servida desde la raiz de su propio dominio.
  if (partes[0] === BASE.slice(1)) partes.shift();
  return partes;
}

/** Cambia la URL sin recargar. `reemplazar` evita ensuciar el historial
 * cuando el cambio no es una navegacion del usuario. */
export function irA(ruta: string, reemplazar = false) {
  const actual = window.location.pathname + window.location.search;
  const destino = ruta + window.location.search;
  if (actual === destino) return;
  if (reemplazar) window.history.replaceState({}, "", destino);
  else window.history.pushState({}, "", destino);
}
