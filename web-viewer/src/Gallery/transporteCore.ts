// Logica del "sistema de llamados": de donde salen los bytes de un dibujo.
//
// Orden de preferencia, decidido UNA vez por carga de pagina (y vuelto a
// decidir si el tunel se cae):
//
//   1. TUNEL  — el nodo (PC con `_FilesSync`) sirve C:\ARQ\BIM\Concepts por su
//               tunel de Cloudflare. Mas rapido y no gasta cuota de Drive.
//   2. DRIVE  — el proxy `concepts-drive`. Siempre disponible; es el respaldo.
//
// Este archivo NO importa `../config` ni toca `window`/`fetch` directo: todo
// lo de afuera entra por `Dependencias`, asi `node --test` lo corre tal cual
// (ver transporteCore.test.mjs) y los fallos de cada eslabon se pueden
// provocar uno por uno.

export type Modo = "tunel" | "drive";

export interface EstadoTransporte {
  modo: Modo;
  /** Por que se eligio ese modo. Estable, para grepear y para la tabla de metricas. */
  motivo: string;
  nodoId?: string;
  tunelUrl?: string;
  /** Ida y vuelta del navegador al tunel (`/salud`), en ms. */
  rttMs?: number;
  /** Cuando se decidio, en ms epoch. */
  decididoEn: number;
}

/** Lo que la galeria necesita para leer un dibujo por rangos. */
export interface FuenteArchivo {
  origen: Modo;
  motivo: string;
  url: string;
  headers: Record<string, string>;
  /** Solo tunel: el tunel no expone `Content-Range`, asi que el tamaño viene firmado. */
  size?: number;
  /** Solo tunel: pide un permiso nuevo (vencen a los 10 min). `null` si el
   * archivo cambio o el tunel ya no sirve. */
  renovar?: () => Promise<{ url: string; size: number } | null>;
  /** Solo tunel: a donde conmutar si el tunel se cae en mitad de la lectura. */
  alternativa?: { url: string; headers: Record<string, string> };
}

export interface PedidoFuente {
  fileId: string;
  nombre: string;
  /** Carpetas contenedoras desde la raiz de Drive (sin la raiz). */
  ruta: string[];
  /** `modifiedAt` de Drive (ISO) y si trae hora real o solo el dia. */
  modifiedAt?: string | null;
  hasTime?: boolean;
}

export interface RespuestaEstado {
  ok: boolean;
  firma?: boolean;
  nodo?: { id: string; tunelUrl: string } | null;
  motivo?: string;
}

export interface RespuestaFirmar {
  ok: boolean;
  url?: string;
  size?: number;
  mtimeMs?: number;
  expiraEnMs?: number;
  nodoId?: string;
  motivo?: string;
}

export interface Salud {
  ok?: boolean;
  operativo?: boolean;
  transporte?: string;
  interruptorActivo?: boolean;
  carpetaCompartida?: string;
}

export interface Dependencias {
  /** Llama a la Edge Function `concepts-nodo`. Rechaza si no hay red o vence. */
  llamarFuncion<T>(accion: "estado" | "firmar", params: Record<string, string>, topeMs: number): Promise<T>;
  /** GET `<tunel>/salud` desde el navegador. Rechaza si CORS/red/timeout. */
  pedirSalud(tunelUrl: string, topeMs: number): Promise<Salud>;
  /** URL + headers de Drive para un id: el camino de siempre. */
  fuenteDrive(fileId: string): { url: string; headers: Record<string, string> };
  ahora(): number;
  /** `drive` o `tunel` fuerza el modo (`?transporte=`); `null` = automatico. */
  forzado(): Modo | null;
}

export interface EventoTransporte {
  t: number;
  tipo: "sonda" | "firma" | "caida" | "conmutacion" | "renovacion";
  detalle: Record<string, unknown>;
}

// --- Tiempos -------------------------------------------------------------
/** Tope de la consulta de estado a la Edge Function. */
export const TOPE_ESTADO_MS = 4_000;
/** Tope del `/salud` directo al tunel. Un tunel sano contesta en ~100 ms. */
export const TOPE_SALUD_MS = 3_500;
/** Tope de pedir un permiso (la funcion lista la carpeta en el nodo). */
export const TOPE_FIRMAR_MS = 9_000;
/** Cuanto se espera una sonda en curso antes de usar Drive para ESE pedido.
 * No bloquea la UI: la sonda sigue y el proximo pedido ya la encuentra lista. */
export const ESPERA_SONDA_MS = 2_500;
/** Tras una caida, cuanto tarda en volver a probar el tunel. */
export const REINTENTO_TRAS_CAIDA_MS = 120_000;
/** Cuanto antes de vencer se renueva un permiso. */
export const MARGEN_RENOVAR_MS = 60_000;

/** Motivos de `firmar` que dicen "el tunel/nodo no sirve": bajan el modo para
 * TODOS los pedidos. Los demas (`no-esta-en-nodo`) son de ese archivo solo. */
const MOTIVOS_DE_CAIDA = new Set([
  "sin-nodos",
  "tunel-no-responde",
  "flota-no-responde",
  "nodo-rechazo",
  "sin-firma",
  "interno",
]);

/** Una fila de `drive_folder_cache`, en lo que importa aca. */
export interface FilaArbol {
  folder_id: string;
  name: string;
  subfolders: { id: string; name: string }[];
  files: { id: string; name: string; modifiedAt: string | null; hasTime: boolean }[];
}

/**
 * De un id de Drive al archivo REAL del arbol cacheado: nombre completo (con
 * `.concepts`, que la galeria muestra sin), carpetas desde la raiz y fecha.
 *
 * Hace falta porque quien abre un dibujo solo tiene el id y un nombre ya
 * limpiado, y la ruta del nodo (`BIM\Concepts\...`) se arma con los nombres
 * EXACTOS de Drive: un espacio o un punto de menos es otro archivo.
 */
export function localizarEnArbol(
  arbol: ReadonlyMap<string, FilaArbol>,
  fileId: string,
): { nombre: string; ruta: string[]; modifiedAt: string | null; hasTime: boolean } | null {
  const padre = new Map<string, string>();
  arbol.forEach((fila) => fila.subfolders.forEach((sub) => padre.set(sub.id, fila.folder_id)));
  for (const fila of arbol.values()) {
    const archivo = fila.files?.find((f) => f.id === fileId);
    if (!archivo) continue;
    const ruta: string[] = [];
    let actual: string | undefined = fila.folder_id;
    // Se sube hasta la raiz; la raiz no tiene padre y no entra en la ruta.
    while (actual && padre.has(actual)) {
      ruta.unshift(arbol.get(actual)?.name ?? "");
      actual = padre.get(actual);
    }
    if (ruta.some((r) => r.length === 0)) return null;
    return { nombre: archivo.name, ruta, modifiedAt: archivo.modifiedAt, hasTime: archivo.hasTime };
  }
  return null;
}

/**
 * `ruta` de Drive -> la que entiende `concepts-nodo`: segmentos con "/".
 * (El nombre del archivo es el ultimo segmento.)
 */
export function rutaParaNodo(ruta: string[], nombre: string): string {
  return [...ruta, nombre].join("/");
}

/**
 * ¿La copia del nodo esta al dia con la de Drive?
 *
 * Drive manda: si Concepts subio una version nueva y el nodo todavia no la
 * recibio, abrir la del nodo mostraria un dibujo VIEJO sin avisar, que es peor
 * que tardar mas. Cuando Drive solo informa el dia (`hasTime` false), se
 * compara contra el principio de ese dia: la copia local del mismo dia vale.
 * Sin dato de Drive no hay con que comparar y se confia en el nodo.
 */
export function copiaAlDia(mtimeNodoMs: number, modifiedAtDrive: string | null | undefined, hasTime: boolean | undefined): boolean {
  if (!modifiedAtDrive) return true;
  const drive = new Date(modifiedAtDrive).getTime();
  if (!Number.isFinite(drive)) return true;
  if (!Number.isFinite(mtimeNodoMs)) return false;
  // Subir a Drive y bajar al nodo no son instantaneos ni los relojes
  // coinciden: 10 min de tolerancia para no descartar copias buenas.
  const TOLERANCIA_MS = 10 * 60_000;
  if (hasTime === false) {
    const d = new Date(drive);
    const inicioDelDia = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return mtimeNodoMs >= inicioDelDia - TOLERANCIA_MS;
  }
  return mtimeNodoMs >= drive - TOLERANCIA_MS;
}

function saludSirve(s: Salud): boolean {
  return s.ok === true && s.operativo === true && s.interruptorActivo !== true && (s.transporte === undefined || s.transporte === "conectado");
}

export function crearTransporte(deps: Dependencias) {
  let estado: EstadoTransporte | null = null;
  let sonda: Promise<EstadoTransporte> | null = null;
  const registro: EventoTransporte[] = [];
  const firmasEnVuelo = new Map<string, Promise<FuenteArchivo>>();

  function anotar(tipo: EventoTransporte["tipo"], detalle: Record<string, unknown>) {
    registro.push({ t: deps.ahora(), tipo, detalle });
    if (registro.length > 200) registro.shift();
  }

  function aDrive(motivo: string, extra: Partial<EstadoTransporte> = {}): EstadoTransporte {
    return { modo: "drive", motivo, decididoEn: deps.ahora(), ...extra };
  }

  async function sondear(): Promise<EstadoTransporte> {
    const forzado = deps.forzado();
    if (forzado === "drive") return aDrive("forzado");
    const t0 = deps.ahora();
    try {
      const est = await deps.llamarFuncion<RespuestaEstado>("estado", {}, TOPE_ESTADO_MS);
      if (!est.ok) return aDrive("estado-fallo");
      if (!est.nodo) return aDrive(est.motivo ?? "sin-nodos");
      if (!est.firma) return aDrive("sin-firma", { nodoId: est.nodo.id });

      const t1 = deps.ahora();
      const salud = await deps.pedirSalud(est.nodo.tunelUrl, TOPE_SALUD_MS);
      const rttMs = deps.ahora() - t1;
      if (!saludSirve(salud)) return aDrive("tunel-no-sirve", { nodoId: est.nodo.id, rttMs });
      return {
        modo: "tunel",
        motivo: "ok",
        nodoId: est.nodo.id,
        tunelUrl: est.nodo.tunelUrl,
        rttMs,
        decididoEn: deps.ahora(),
      };
    } catch (e) {
      const nombre = e instanceof Error ? e.name : "error";
      return aDrive(`sonda-${nombre === "TimeoutError" || nombre === "AbortError" ? "timeout" : "fallo"}`, {
        rttMs: deps.ahora() - t0,
      });
    }
  }

  /** Arranca la sonda (una sola a la vez). Idempotente. */
  function iniciarSondeo(): Promise<EstadoTransporte> {
    if (sonda) return sonda;
    sonda = sondear().then((e) => {
      estado = e;
      anotar("sonda", { modo: e.modo, motivo: e.motivo, rttMs: e.rttMs, nodoId: e.nodoId });
      return e;
    });
    return sonda;
  }

  /** Estado vigente. Si el tunel estaba caido hace rato, vuelve a probar en
   * segundo plano (sin hacer esperar a quien pregunta). */
  async function estadoActual(): Promise<EstadoTransporte> {
    if (estado && estado.modo === "drive" && estado.motivo.startsWith("caido:") && deps.ahora() - estado.decididoEn >= REINTENTO_TRAS_CAIDA_MS && deps.forzado() === null) {
      sonda = null;
      void iniciarSondeo();
    }
    if (!sonda) void iniciarSondeo();
    if (estado) return estado;
    const enCurso = sonda!;
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const tope = new Promise<null>((r) => {
      reloj = setTimeout(() => r(null), ESPERA_SONDA_MS);
    });
    try {
      return (await Promise.race([enCurso, tope])) ?? aDrive("sonda-pendiente");
    } finally {
      clearTimeout(reloj);
    }
  }

  function marcarCaido(motivo: string) {
    if (deps.forzado() === "tunel") return;
    estado = aDrive(`caido:${motivo}`);
    sonda = Promise.resolve(estado);
    anotar("caida", { motivo });
  }

  function drive(pedido: PedidoFuente, motivo: string): FuenteArchivo {
    const d = deps.fuenteDrive(pedido.fileId);
    return { origen: "drive", motivo, url: d.url, headers: d.headers };
  }

  async function firmarYArmar(pedido: PedidoFuente, est: EstadoTransporte): Promise<FuenteArchivo> {
    const ruta = rutaParaNodo(pedido.ruta, pedido.nombre);
    let r: RespuestaFirmar;
    try {
      r = await deps.llamarFuncion<RespuestaFirmar>("firmar", { ruta }, TOPE_FIRMAR_MS);
    } catch (e) {
      const motivo = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "firmar-timeout" : "firmar-fallo";
      anotar("firma", { ok: false, motivo, fileId: pedido.fileId });
      marcarCaido(motivo);
      return drive(pedido, motivo);
    }
    anotar("firma", { ok: r.ok, motivo: r.motivo, fileId: pedido.fileId, size: r.size });
    if (!r.ok || !r.url || typeof r.size !== "number" || r.size <= 0) {
      const motivo = r.motivo ?? "firma-incompleta";
      if (MOTIVOS_DE_CAIDA.has(motivo)) marcarCaido(motivo);
      return drive(pedido, motivo);
    }
    if (!copiaAlDia(r.mtimeMs ?? NaN, pedido.modifiedAt, pedido.hasTime)) {
      return drive(pedido, "nodo-desactualizado");
    }

    const tamano = r.size;
    let expiraEnMs = r.expiraEnMs ?? deps.ahora() + 5 * 60_000;
    const base: FuenteArchivo = {
      origen: "tunel",
      motivo: est.motivo,
      url: r.url,
      headers: {},
      size: tamano,
      alternativa: deps.fuenteDrive(pedido.fileId),
      renovar: async () => {
        // Un solo permiso vigente por vez: si ya se renovo hace poco, no se pide otro.
        if (expiraEnMs - deps.ahora() > MARGEN_RENOVAR_MS) return { url: base.url, size: tamano };
        try {
          const n = await deps.llamarFuncion<RespuestaFirmar>("firmar", { ruta }, TOPE_FIRMAR_MS);
          anotar("renovacion", { ok: n.ok, motivo: n.motivo, fileId: pedido.fileId });
          // Si el archivo cambio de tamaño, los offsets que ya se leyeron ya no valen.
          if (!n.ok || !n.url || n.size !== tamano) return null;
          expiraEnMs = n.expiraEnMs ?? deps.ahora() + 5 * 60_000;
          base.url = n.url;
          return { url: n.url, size: tamano };
        } catch {
          return null;
        }
      },
    };
    return base;
  }

  /**
   * Resuelve de donde leer un dibujo. NUNCA rechaza: lo peor que puede pasar
   * es que devuelva Drive, que es lo que se hacia antes de que existiera esto.
   */
  async function resolverFuente(pedido: PedidoFuente): Promise<FuenteArchivo> {
    const est = await estadoActual();
    if (est.modo !== "tunel") return drive(pedido, est.motivo);

    const clave = rutaParaNodo(pedido.ruta, pedido.nombre);
    const previa = firmasEnVuelo.get(clave);
    if (previa) return previa;
    const p = firmarYArmar(pedido, est).finally(() => firmasEnVuelo.delete(clave));
    firmasEnVuelo.set(clave, p);
    return p;
  }

  /** Para que el lector avise que conmuto a mitad de lectura. */
  function anotarConmutacion(detalle: Record<string, unknown>) {
    anotar("conmutacion", detalle);
  }

  return {
    iniciarSondeo,
    estadoActual,
    resolverFuente,
    marcarCaido,
    anotarConmutacion,
    /** Foto para depurar (`window.__transporte`) y para los arneses. */
    instantanea: () => ({ estado, registro: [...registro] }),
  };
}

export type Transporte = ReturnType<typeof crearTransporte>;
