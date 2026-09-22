// Wrapper tipado de UnxCentinela (ver C:\.TBT\Proyectos\_Otros_Escuchas\CENTINELA.md).
//
// El centinela lo inyecta el gateway en el <head>, ANTES de que este bundle
// se evalue: no se copia al repo (Concept no es una PWA con shell cacheado).
// Pero puede no estar -- kill switch, un shell viejo servido por un service
// worker de otro modulo, o esta misma app abierta directo en su dominio de
// Vercel sin pasar por babelbim.com -- asi que TODA llamada es un no-op
// silencioso si `window.UnxCentinela` no existe o no tiene el metodo. Import
// SIEMPRE de aca, nunca de `window.UnxCentinela` directo (R2-04, F2_MODULOS.md).

declare global {
  interface Window {
    UnxCentinela?: {
      fase: (nombre: string) => void;
      listo: () => void;
      fallo: (codigo: string, detalle?: Record<string, unknown>) => void;
      recargar: (motivo: string) => boolean;
      conTope: <T>(promesa: Promise<T>, ms: number, codigo?: string) => Promise<T>;
      sesionVencida: () => void;
      estado: () => unknown;
      incidente: string;
      volver: () => void;
      contexto: "documento" | "iframe";
    };
  }
}

function centinela(): Window["UnxCentinela"] {
  return typeof window !== "undefined" ? window.UnxCentinela : undefined;
}

/** Guarda un hito real del arranque. Nombres cortos: "bundle", "lista",
 * "render", "dibujo:<id>". Nunca tira. */
export function fase(nombre: string): void {
  try {
    centinela()?.fase(nombre);
  } catch {
    /* nunca tira */
  }
}

/** El modulo ya es usable. Apaga el watchdog del centinela. */
export function listo(): void {
  try {
    centinela()?.listo();
  } catch {
    /* nunca tira */
  }
}

/** Reporta un codigo del catalogo (`_Otros_Escuchas/codigos-fallo.json`) con
 * un detalle sin secretos: nunca tokens, cookies, ni contenido de archivos. */
export function fallo(codigo: string, detalle?: Record<string, unknown>): void {
  try {
    centinela()?.fallo(codigo, detalle);
  } catch {
    /* nunca tira */
  }
}

/** Unica forma de recargar la pagina en el parque (D4 de 00_PLAN.md). Si el
 * centinela no esta, devuelve false: el llamador cae a su propia guarda. */
export function recargar(motivo: string): boolean {
  try {
    return centinela()?.recargar(motivo) ?? false;
  } catch {
    return false;
  }
}

/** Pone un tope a un await de arranque. Sin centinela, devuelve la promesa
 * pelada (mismo comportamiento, sin el fallo automatico al vencer). */
export function conTope<T>(promesa: Promise<T>, ms: number, codigo?: string): Promise<T> {
  const c = centinela();
  if (c && typeof c.conTope === "function") {
    try {
      return c.conTope(promesa, ms, codigo);
    } catch {
      /* sigue con la promesa pelada */
    }
  }
  return promesa;
}

/** Un fetch propio devolvio 401 con `x-unx-sesion: vencida`. */
export function sesionVencida(): void {
  try {
    centinela()?.sesionVencida();
  } catch {
    /* nunca tira */
  }
}

/** Mismo boton "Volver al portal" que usa la pantalla de fallback del
 * centinela: avisa al Portal por postMessage ({unx:'volver',v:1}) y, si en
 * 1500 ms nadie respondio (no esta embebido, o el Portal no esta), navega a
 * la raiz. La navegacion la resuelve el centinela: esta funcion no implementa
 * nada propio, solo delega. */
export function volver(): void {
  try {
    centinela()?.volver();
  } catch {
    /* nunca tira */
  }
}

/** "documento" | "iframe" | null. Sin centinela (kill switch, o esta pagina
 * abierta fuera del gateway) no hay forma confiable de saberlo, asi que cada
 * lugar que la usa decide su propio plan B (ver PortalVolver.tsx: cae a
 * `window.self !== window.top`). */
export function contexto(): "documento" | "iframe" | null {
  try {
    return centinela()?.contexto ?? null;
  } catch {
    return null;
  }
}
