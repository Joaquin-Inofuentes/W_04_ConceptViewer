import { insertEvento } from "./supabaseClient";

export type DescargaOrigen = "galeria" | "lienzo" | "foto";

// Un id por pestaña/sesion de navegacion, para poder agrupar eventos del
// mismo visitante sin pedir login.
//
// `crypto.randomUUID()` solo existe en contextos SEGUROS (https, o
// localhost). Evaluarlo a nivel de MODULO significaba que probar el build
// desde el telefono en `http://192.168.1.x:5173` (el flujo real para medir
// gama baja en un dispositivo real, ver PLAN_IMPLEMENTACION.md) tiraba un
// `TypeError` en la evaluacion del modulo -- y como `Gallery.tsx` importa
// este archivo, la app entera quedaba en pantalla en blanco, sin ninguna
// relacion aparente con analytics. Se resuelve perezosamente (recien cuando
// hace falta, dentro de un `try`) y con un fallback que no depende de la
// API criptografica.
let sesionId: string | null = null;
function idDeSesion(): string {
  if (sesionId) return sesionId;
  try {
    sesionId = crypto.randomUUID();
  } catch {
    sesionId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
  return sesionId;
}

async function registrarEvento(
  evento: "abrir" | "cerrar" | "descargar" | "buscar" | "tema",
  campos: Record<string, unknown>
) {
  await insertEvento({ evento, sesion_id: idDeSesion(), ...campos });
}

export function logAbrir(archivoId: string, archivoNombre: string, carpetaId: string) {
  void registrarEvento("abrir", {
    archivo_id: archivoId,
    archivo_nombre: archivoNombre,
    carpeta_id: carpetaId,
    exito: true,
  });
}

export function logAbrirError(
  archivoId: string | null,
  archivoNombre: string | null,
  carpetaId: string | null,
  errorCodigo: string,
  errorMensaje: string
) {
  void registrarEvento("abrir", {
    archivo_id: archivoId,
    archivo_nombre: archivoNombre,
    carpeta_id: carpetaId,
    exito: false,
    error_codigo: errorCodigo,
    error_mensaje: errorMensaje,
  });
}

export function logBuscar(query: string, resultados: number) {
  void registrarEvento("buscar", { query, resultados });
}

export function logTema(tema: "claro" | "oscuro", origen: "galeria" | "lienzo") {
  void registrarEvento("tema", { tema, origen });
}

export function logCerrar(archivoId: string | null, archivoNombre: string | null) {
  void registrarEvento("cerrar", { archivo_id: archivoId, archivo_nombre: archivoNombre });
}

export function logDescarga(
  origen: DescargaOrigen,
  formato: string,
  archivoIds: string[],
  archivoNombre?: string | null,
  carpetaId?: string | null
) {
  void registrarEvento("descargar", {
    origen,
    formato,
    archivo_ids: archivoIds,
    archivo_id: archivoIds.length === 1 ? archivoIds[0] : null,
    archivo_nombre: archivoNombre ?? null,
    cantidad_archivos: archivoIds.length,
    carpeta_id: carpetaId ?? null,
  });
}
