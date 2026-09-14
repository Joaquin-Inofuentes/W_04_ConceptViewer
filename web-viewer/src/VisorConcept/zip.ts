/**
 * Lector de ZIP minimo, pensado para archivos .concepts.
 *
 * Reemplaza a JSZip por tres razones concretas, medidas sobre la carpeta real
 * de Drive:
 *
 *  1. JSZip no puede abrir los .concepts mas grandes. Los cuatro dibujos mas
 *     pesados (262, 237, 196 y 154 MB) fallaban con "Corrupted zip or bug:
 *     unexpected signature" aunque el zip es perfectamente valido (lo abren
 *     .NET, Windows y cualquier unzip). Eran, literalmente, imposibles de
 *     abrir desde la app.
 *  2. JSZip descomprime en JavaScript. Aca se usa DecompressionStream, que es
 *     el inflate nativo del navegador: bastante mas rapido y sin ocupar el
 *     hilo principal haciendo aritmetica byte a byte.
 *  3. JSZip necesita el archivo ENTERO en memoria. Aca la fuente de bytes es
 *     abstracta (`ZipSource`), asi que el archivo puede vivir en un servidor
 *     y leerse por rangos HTTP. Medido: del dibujo de 262,9 MB solo hacen
 *     falta 10,9 MB (4%) para verlo completo — el resto son adjuntos que
 *     nunca se colocaron en el lienzo.
 */

import { getBudgets } from "../device";

/** Techo duro para cualquier camino que necesite materializar los bytes de
 * una fuente REMOTA de una sola vez (indice reconstruido por escaneo, o un
 * servidor que ignoro el Range y mando el archivo entero). Sin este techo,
 * un .concepts truncado o mal servido de 262 MB se intenta cargar completo
 * en RAM en un telefono de 1 GB y la pestaña muere sin ningun mensaje. El
 * multiplicador de 2 sobre el cache de buffers da margen: son casos raros
 * (archivo dañado / CDN sirviendo sin Range) y preferimos fallar con un
 * mensaje legible antes que arriesgar el OOM. */
function techoMaterializable(): number {
  return getBudgets().maxBufferCacheBytes * 2;
}

export class ArchivoDemasiadoGrandeError extends Error {
  constructor(bytes: number, techo: number) {
    super(
      `Este archivo (${(bytes / (1024 * 1024)).toFixed(0)} MB) esta dañado, incompleto, o el servidor no soporta descarga parcial, y hace falta bajarlo entero para leerlo. En este dispositivo el limite es ${(techo / (1024 * 1024)).toFixed(0)} MB.`
    );
    this.name = "ArchivoDemasiadoGrandeError";
  }
}

/**
 * Un pedido al proxy `concepts-drive` que volvio con el cuerpo de error del
 * contrato de R3-01 (`{codigo, causa, detalle, id}`).
 *
 * Antes todo fallo del proxy llegaba aca como `Rango bytes=-131072 fallo
 * (502)` y nada mas: no habia forma de distinguir "el dibujo ya no existe en
 * Drive" (que no se arregla reintentando) de "Drive se cayo un segundo" (que
 * si). Se reintentaba tres veces, con 1,6 s de espera, para terminar en el
 * mismo error — y el mensaje que veia la persona no decia que hacer.
 */
export class ErrorProxyConcepts extends Error {
  readonly status: number;
  readonly range: string | null;
  /** Codigo del catalogo que puso la funcion, si lo puso. */
  readonly codigo: string | null;
  /** Etiqueta corta y estable: drive-404, drive-sin-rangos, timeout, ... */
  readonly causa: string | null;
  /** Id del fallo en los logs de Supabase: es lo que hay que mandar para que
   * alguien pueda encontrar la linea. */
  readonly idFallo: string | null;

  constructor(
    mensaje: string,
    datos: { status: number; range: string | null; codigo?: string | null; causa?: string | null; idFallo?: string | null }
  ) {
    super(mensaje);
    this.name = "ErrorProxyConcepts";
    this.status = datos.status;
    this.range = datos.range;
    this.codigo = datos.codigo ?? null;
    this.causa = datos.causa ?? null;
    this.idFallo = datos.idFallo ?? null;
  }

  /** Reintentar no lo va a arreglar: el archivo no esta, el pedido era
   * invalido, o el servidor ya dijo que no sabe servir rangos. */
  get esDefinitivo(): boolean {
    if (this.causa === "drive-404" || this.causa === "pedido-invalido" || this.causa === "drive-sin-rangos") {
      return true;
    }
    // Sin causa (una respuesta vieja o de otro intermediario): cualquier 4xx
    // que no sea "vuelve a intentar" tampoco mejora repitiendo.
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }

  /** El servidor no pudo servir el rango: hay que bajar el archivo entero. */
  get pideDescargaCompleta(): boolean {
    return this.causa === "drive-sin-rangos" || this.status === 416;
  }
}

/** Mensaje honesto y accionable para cada causa del proxy. El texto se muestra
 * tal cual en la pantalla de error del visor, asi que dice QUE PASO y QUE
 * HACER, sin nombrar rutas ni versiones. */
function mensajeDeCausa(causa: string | null, range: string, status: number): string {
  switch (causa) {
    case "drive-404":
      return "Este dibujo ya no está en Drive con ese identificador: lo más probable es que se haya vuelto a subir desde Concepts. Actualizá la lista de la carpeta y abrilo de nuevo.";
    case "drive-sin-rangos":
      return `El servidor no pudo mandar solo la parte que hacía falta (${range}): hay que bajar el dibujo entero.`;
    case "timeout":
      return "Drive tardó demasiado en contestar. Probá de nuevo en un momento.";
    case "pedido-invalido":
      return "El pedido no era válido. Volvé a la lista y abrí el dibujo otra vez.";
    default:
      return `Rango ${range} fallo (${status})`;
  }
}

/** Lee el cuerpo de error del proxy. Si no viene JSON (un 502 del gateway, la
 * pagina de login), devuelve lo minimo para no perder el status. */
async function errorDelProxy(res: Response, range: string): Promise<ErrorProxyConcepts> {
  let codigo: string | null = null;
  let causa: string | null = null;
  let idFallo: string | null = null;
  let detalle: string | null = null;
  try {
    const cuerpo = await res.json();
    if (cuerpo && typeof cuerpo === "object") {
      codigo = typeof cuerpo.codigo === "string" ? cuerpo.codigo : null;
      causa = typeof cuerpo.causa === "string" ? cuerpo.causa : null;
      idFallo = typeof cuerpo.id === "string" ? cuerpo.id : null;
      detalle = typeof cuerpo.detalle === "string" ? cuerpo.detalle : null;
    }
  } catch {
    // El cuerpo no era JSON: nos quedamos con el status, que ya dice algo.
  }
  // El formato viejo (`Rango <x> fallo (<n>)`) se mantiene como fallback
  // porque `lib/erroresDescarga.ts` lo parsea para separar rango y status.
  let mensaje = mensajeDeCausa(causa, range, res.status);
  if (idFallo) mensaje += ` (referencia ${idFallo})`;
  if (!causa && detalle) mensaje += ` — ${detalle}`;
  return new ErrorProxyConcepts(mensaje, { status: res.status, range, codigo, causa, idFallo });
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_DATA_DESC = 0x08074b50;

/** Cuanto se lee del final del archivo para encontrar el indice central.
 * El comentario del zip puede meter hasta 64 KB, y el directorio central de
 * un .concepts con 99 entradas ronda los 10 KB: 128 KB cubre ambos de una. */
const COLA_INDICE = 128 * 1024;

/** Fuente de bytes de un zip. Puede ser un ArrayBuffer ya en memoria, un
 * File local, o un archivo remoto leido por rangos HTTP. */
export interface ZipSource {
  readonly size: number;
  /** Devuelve los bytes [offset, offset+length). Puede devolver menos si el
   * archivo termina antes. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class BufferSource implements ZipSource {
  private bytes: Uint8Array;
  readonly size: number;
  constructor(buffer: ArrayBuffer | Uint8Array) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.size = this.bytes.length;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.bytes.subarray(offset, Math.min(offset + length, this.size));
  }
}

/** Fuente para un archivo elegido por el usuario con <input type=file>. No
 * carga el archivo entero: File.slice() es perezoso. */
export class FileSource implements ZipSource {
  readonly size: number;
  private file: File;
  constructor(file: File) {
    this.file = file;
    this.size = file.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const buf = await this.file.slice(offset, Math.min(offset + length, this.size)).arrayBuffer();
    return new Uint8Array(buf);
  }
}

export interface RemoteSourceOptions {
  /** Bytes totales, si ya se conocen (evita una request de sondeo). */
  size?: number;
  signal?: AbortSignal;
  /** Se llama con los bytes efectivamente transferidos, para medir/mostrar. */
  onBytes?: (n: number) => void;
}

/**
 * Fuente remota que lee por rangos HTTP. Verificado contra Drive: honra
 * `Range` tanto en la URL directa como despues del interstitial de virus.
 *
 * Agrupa lecturas: pedir 99 rangos chiquitos cuesta mas en latencia (150 ms
 * de RTT en 3G, cada uno) que pedir un bloque contiguo un poco mas grande,
 * asi que las lecturas cercanas se sirven de un cache de bloques.
 */
export class RemoteSource implements ZipSource {
  size = 0;
  private bloques: { start: number; end: number; bytes: Uint8Array }[] = [];
  /** Rangos pedidos y todavia sin respuesta, para no pedir dos veces lo
   * mismo cuando el prefetch agrupado y el pool de recursos se solapan. */
  private pendientes: { start: number; end: number; promesa: Promise<void> }[] = [];
  private signal?: AbortSignal;
  private onBytes?: (n: number) => void;
  /** Bytes que se piden de mas alrededor de una lectura chica, para que la
   * siguiente lectura cercana salga del cache en vez de otra request. */
  private readonly HOLGURA = 64 * 1024;
  /**
   * Techo del cache de bloques. Guarda el indice y lo que se esta leyendo,
   * nunca el archivo entero.
   *
   * Antes 12 MB fijos, sin importar el dispositivo -- el unico presupuesto
   * de todo el pipeline de imagenes que ignoraba `device.ts`. Se deriva del
   * presupuesto general de buffers (25%, con piso de 8 MB y techo de 64 MB):
   * en gama baja da exactamente los mismos 12 MB de siempre (48 MB * 0.25),
   * asi que no hay regresion ahi; en gama media/alta da mas margen para
   * agrupar rangos y evitar viajes de red redundantes.
   */
  private readonly MAX_CACHE_BYTES = Math.max(
    8 * 1024 * 1024,
    Math.min(getBudgets().maxBufferCacheBytes * 0.25, 64 * 1024 * 1024)
  );

  /** Cuanto puede adelantar `prefetch` sin que lo adelantado se desaloje solo.
   * Se deja un margen para el indice y las lecturas en curso. */
  get capacidadCache(): number {
    return this.MAX_CACHE_BYTES - 2 * 1024 * 1024;
  }

  private url: string;
  private headers: Record<string, string>;
  /** URL directa de Drive que devolvio el proxy la primera vez. Reenviarla
   * evita que el proxy tenga que re-resolver el interstitial en cada rango. */
  private urlResuelta: string | null = null;

  private constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }

  static async open(
    url: string,
    headers: Record<string, string> = {},
    opts: RemoteSourceOptions = {}
  ): Promise<RemoteSource> {
    const s = new RemoteSource(url, headers);
    s.signal = opts.signal;
    s.onBytes = opts.onBytes;
    if (opts.size) s.size = opts.size;
    return s;
  }

  /** Lee los ultimos `n` bytes con un rango sufijo (`bytes=-n`). Sirve para
   * traer el indice del zip Y descubrir el tamaño total en UNA sola request:
   * cada ida y vuelta a Drive via el proxy cuesta ~1,7 s, asi que ahorrar
   * requests importa mas que ahorrar bytes. */
  async leerCola(n: number): Promise<{ bytes: Uint8Array; offset: number }> {
    let res: { bytes: Uint8Array; total: number | null; status: number };
    try {
      res = await this.fetchRaw(`bytes=-${n}`, `-${n}`);
    } catch (e) {
      // El servidor dijo explicitamente que no puede servir ese rango (416 +
      // causa drive-sin-rangos). Bajar el archivo entero es lo unico que
      // queda, y se hace A PROPOSITO — con progreso y con el techo de RAM del
      // dispositivo — en vez de dejar el dibujo sin abrir.
      if (e instanceof ErrorProxyConcepts && e.pideDescargaCompleta) {
        await this.bajarEntero();
        const desde = Math.max(0, this.size - n);
        return { bytes: await this.read(desde, this.size - desde), offset: desde };
      }
      throw e;
    }
    this.size = res.total ?? res.bytes.length;
    const offset = Math.max(0, this.size - res.bytes.length);
    this.bloques.push({ start: offset, end: offset + res.bytes.length - 1, bytes: res.bytes });
    return { bytes: res.bytes, offset };
  }

  /** ¿Ya se bajo el archivo entero por no haber rangos? Evita volver a bajarlo
   * cuando el siguiente rango tambien falle. */
  private enteroEnMemoria = false;

  /**
   * Descarga el archivo COMPLETO (sin Range) y lo deja como un solo bloque en
   * el cache, para que el resto del lector siga funcionando igual.
   *
   * Es el camino de respaldo de `UNX-F4005`: si el proxy no puede servir
   * rangos, el dibujo igual se abre, solo que tarda mas. `onBytes` sigue
   * llamandose con cada chunk, asi que la barra de progreso del visor se
   * mueve en vez de quedarse muda medio minuto.
   */
  private async bajarEntero(): Promise<void> {
    // El bloque tiene que seguir estando: si alguien lo libero, hay que
    // bajarlo de nuevo (pedir rangos no es una opcion en este camino).
    if (this.enteroEnMemoria && this.bloques.length > 0) return;
    const sep = this.url.includes("?") ? "&" : "?";
    const u = this.urlResuelta ? `${this.url}${sep}u=${encodeURIComponent(this.urlResuelta)}` : this.url;
    // Un archivo entero puede ser de cientos de MB por una conexion movil: el
    // tope es mucho mas generoso que el de un rango, pero existe igual (regla
    // dura del parque: ningun await de arranque sin tope). 120 s + 1 s/MB del
    // techo del dispositivo.
    const topeMs = 120_000 + (techoMaterializable() / (1024 * 1024)) * 1000;
    const timeoutSignal = AbortSignal.timeout(topeMs);
    const signal = this.signal ? AbortSignal.any([this.signal, timeoutSignal]) : timeoutSignal;
    const res = await fetch(u, { headers: this.headers, signal });
    if (!res.ok) throw await errorDelProxy(res, "(archivo entero)");

    const declarado = Number(res.headers.get("x-drive-total") || res.headers.get("content-length") || "0");
    const techo = techoMaterializable();
    if (declarado > techo) {
      await res.body?.cancel();
      throw new ArchivoDemasiadoGrandeError(declarado, techo);
    }

    const partes: Uint8Array[] = [];
    let total = 0;
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      partes.push(value);
      total += value.length;
      this.onBytes?.(value.length);
      // El techo se comprueba TAMBIEN mientras llega: un servidor que no
      // declara Content-Length podria pasarse igual.
      if (total > techo) {
        await reader.cancel();
        throw new ArchivoDemasiadoGrandeError(total, techo);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const p of partes) {
      bytes.set(p, offset);
      offset += p.length;
    }
    this.size = total;
    this.bloques = [{ start: 0, end: total - 1, bytes }];
    this.enteroEnMemoria = true;
  }

  /**
   * Pide un rango, con reintentos.
   *
   * Hace falta de verdad: Drive devuelve 5xx cuando lo apuran (visto en
   * pruebas: 502 esporadicos), y una conexion movil corta pedidos a mitad de
   * camino. Sin reintentar, UN rango fallido rompe la apertura entera del
   * dibujo. El backoff es exponencial y ademas descarta la URL resuelta
   * cacheada, que es la otra causa tipica de fallo (vencio el uuid de
   * confirmacion de Drive).
   */
  private async fetchRaw(
    rangeHeader: string,
    rangeParam: string,
    intentos = 3
  ): Promise<{ bytes: Uint8Array; total: number | null; status: number }> {
    let ultimoError: unknown;
    for (let i = 0; i < intentos; i++) {
      if (this.signal?.aborted) throw new Error("cancelado");
      try {
        return await this.fetchRawUnaVez(rangeHeader, rangeParam);
      } catch (e) {
        ultimoError = e;
        // Reintentar lo que el proxy YA dijo que no tiene arreglo (el archivo
        // no esta en Drive, el pedido era invalido, no hay rangos) son 1,6 s
        // de espera para llegar al mismo error: se corta en el primero.
        if (e instanceof ErrorProxyConcepts && e.esDefinitivo) throw e;
        // La URL resuelta pudo vencer: se descarta para que el proxy la
        // vuelva a resolver en el proximo intento.
        this.urlResuelta = null;
        if (i < intentos - 1) {
          await new Promise((r) => setTimeout(r, 400 * Math.pow(3, i)));
        }
      }
    }
    throw ultimoError instanceof Error ? ultimoError : new Error(String(ultimoError));
  }

  private async fetchRawUnaVez(
    rangeHeader: string,
    rangeParam: string
  ): Promise<{ bytes: Uint8Array; total: number | null; status: number }> {
    const sep = this.url.includes("?") ? "&" : "?";
    // La URL ya resuelta de Drive se reenvia al proxy para que no tenga que
    // volver a pedir y parsear la pagina de confirmacion de virus en CADA
    // rango: eso es una ida y vuelta extra a Drive (~700 ms) por request.
    const u = this.urlResuelta
      ? `${this.url}${sep}range=${rangeParam}&u=${encodeURIComponent(this.urlResuelta)}`
      : `${this.url}${sep}range=${rangeParam}`;
    // Sin timeout, un fetch que cuelga (tunel, red movil que murio a mitad de
    // camino sin mandar RST) nunca resuelve NI rechaza: el try/catch de
    // fetchRaw nunca se dispara y los reintentos que ya estan escritos no
    // corren nunca. 20 s alcanza sobradamente para un rango de pocos MB por
    // el proxy de Drive (~1,7 s de ida y vuelta tipico).
    const timeoutSignal = AbortSignal.timeout(20_000);
    const signal = this.signal ? AbortSignal.any([this.signal, timeoutSignal]) : timeoutSignal;
    const res = await fetch(u, {
      headers: { ...this.headers, Range: rangeHeader },
      signal,
    });
    if (!res.ok) throw await errorDelProxy(res, rangeHeader);

    const resuelta = res.headers.get("x-drive-url");
    if (resuelta) this.urlResuelta = resuelta;

    const buf = new Uint8Array(await res.arrayBuffer());
    this.onBytes?.(buf.length);

    let total: number | null = null;
    const xt = res.headers.get("x-drive-total");
    if (xt) total = Number(xt);
    if (total === null) {
      const cr = res.headers.get("content-range");
      const m = cr ? /\/(\d+)$/.exec(cr) : null;
      if (m) total = Number(m[1]);
    }
    return { bytes: buf, total, status: res.status };
  }

  private async fetchRange(
    start: number,
    end: number
  ): Promise<{ bytes: Uint8Array; total: number | null }> {
    let res: { bytes: Uint8Array; total: number | null; status: number };
    try {
      res = await this.fetchRaw(`bytes=${start}-${end}`, `${start}-${end}`);
    } catch (e) {
      // Mismo respaldo que en `leerCola`: el proxy avisa que no hay rangos y
      // el archivo se baja entero (una sola vez), de donde salen este pedido y
      // todos los siguientes.
      if (e instanceof ErrorProxyConcepts && e.pideDescargaCompleta) {
        await this.bajarEntero();
        const bloque = this.bloques[0];
        const fin = Math.min(end, this.size - 1);
        return { bytes: bloque.bytes.subarray(start, fin + 1), total: this.size };
      }
      throw e;
    }
    // Si el servidor IGNORO el Range y mando el archivo entero, el status es
    // 200 y no 206. Se detecta para no interpretar mal los offsets.
    if (res.status !== 206 && res.bytes.length > end - start + 1) {
      const total = res.bytes.length;
      const techo = techoMaterializable();
      if (total > techo) {
        // Guardar esto en `bloques` metería el archivo entero en el cache y
        // `podarBloques` no lo desaloja nunca (ver su guarda de "un solo
        // bloque"): es exactamente el camino que mata la pestaña. Se
        // descarta el resultado y se falla con un mensaje legible en vez de
        // arriesgar el OOM.
        throw new ArchivoDemasiadoGrandeError(total, techo);
      }
      this.size = total;
      this.bloques.push({ start: 0, end: total - 1, bytes: res.bytes });
      this.podarBloques();
      return { bytes: res.bytes.subarray(start, end + 1), total };
    }
    return { bytes: res.bytes, total: res.total };
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const fin = Math.min(offset + length, this.size) - 1;
    if (fin < offset) return new Uint8Array(0);

    const hit = this.bloques.find((b) => b.start <= offset && b.end >= fin);
    if (hit) return hit.bytes.subarray(offset - hit.start, fin - hit.start + 1);

    // Si YA hay una request en vuelo que cubre este rango (tipicamente el
    // prefetch agrupado), se espera esa en vez de pedir los mismos bytes otra
    // vez. Sin esto el adelanto y las lecturas del pool se pisaban y cada
    // recurso podia costar DOS viajes en vez de ninguno.
    const enVuelo = this.pendientes.find((p) => p.start <= offset && p.end >= fin);
    if (enVuelo) {
      await enVuelo.promesa;
      const post = this.bloques.find((b) => b.start <= offset && b.end >= fin);
      if (post) return post.bytes.subarray(offset - post.start, fin - post.start + 1);
    }

    // Para lecturas chicas se pide de mas: en 3G cada request cuesta ~150 ms
    // de RTT, asi que traer 64 KB extra sale mas barato que una request mas.
    const pedirDesde = length < this.HOLGURA ? Math.max(0, offset - 2048) : offset;
    const pedirHasta = Math.min(this.size - 1, Math.max(fin, pedirDesde + this.HOLGURA));

    const entrada = { start: pedirDesde, end: pedirHasta, promesa: Promise.resolve() };
    entrada.promesa = (async () => {
      const { bytes } = await this.fetchRange(pedirDesde, pedirHasta);
      this.bloques.push({ start: pedirDesde, end: pedirDesde + bytes.length - 1, bytes });
      this.podarBloques();
    })();
    this.pendientes.push(entrada);
    try {
      await entrada.promesa;
    } finally {
      this.pendientes = this.pendientes.filter((p) => p !== entrada);
    }

    const listo = this.bloques.find((b) => b.start <= offset && b.end >= fin);
    if (listo) return listo.bytes.subarray(offset - listo.start, fin - listo.start + 1);
    // El bloque pudo ser desalojado por el podado si entraron otros mas
    // grandes mientras tanto; se pide de nuevo, ya sin agrupar.
    const { bytes } = await this.fetchRange(offset, fin);
    return bytes;
  }

  /** El cache de bloques se acota por BYTES, no por cantidad: con el prefetch
   * agrupado un solo bloque puede pesar 3 MB, y ocho de esos son 24 MB — una
   * porcion nada despreciable del presupuesto de un telefono de 1 GB. */
  private podarBloques() {
    // Cuando se bajo el archivo entero (porque el servidor no sirve rangos),
    // ese bloque NO se poda: volver a pedirlo seria volver a fallar. Ya paso
    // por el techo del dispositivo antes de entrar, asi que no es el bloque
    // gigante e inesperado que este podado vino a desalojar.
    if (this.enteroEnMemoria) return;
    let total = this.bloques.reduce((n, b) => n + b.bytes.length, 0);
    // Antes se dejaba `length > 1` para no podar el unico bloque (haria que
    // la lectura en curso se quedara sin sus propios bytes). Pero eso
    // significaba que UN bloque gigante (p.ej. un servidor que ignoro el
    // Range) nunca se desalojaba: quedaba retenido para siempre por encima
    // del presupuesto. `read()` ya sabe recuperarse si el bloque que estaba
    // usando desaparece del cache (vuelve a pedirlo directo), asi que es
    // seguro podar hasta dejar cero: lo unico que se pierde es la cache, no
    // los datos que ya se devolvieron.
    while (total > this.MAX_CACHE_BYTES && this.bloques.length > 0) {
      const fuera = this.bloques.shift();
      total -= fuera ? fuera.bytes.length : 0;
    }
  }

  /** Descarta los bloques cacheados (el indice ya esta parseado en entries).
   * Excepto cuando el archivo entero esta en memoria porque el servidor no
   * sirve rangos: ahi es la unica copia que hay, y tirarla obligaria a
   * bajarlo otra vez para cada recurso. */
  liberar() {
    if (this.enteroEnMemoria) return;
    this.bloques = [];
  }
}

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipArchive {
  readonly entries: Map<string, ZipEntry> = new Map();
  readonly source: ZipSource;

  private constructor(source: ZipSource) {
    this.source = source;
  }

  /**
   * Abre un zip desde cualquier fuente (memoria, File local o remoto por
   * rangos). Lee SOLO el indice; cada entrada se materializa a pedido.
   */
  static async open(source: ZipSource | ArrayBuffer | Uint8Array): Promise<ZipArchive> {
    const src =
      source instanceof ArrayBuffer || source instanceof Uint8Array ? new BufferSource(source) : source;
    const zip = new ZipArchive(src);
    await zip.readIndex();
    return zip;
  }

  private async readIndex() {
    // En una fuente remota se pide la cola con un rango SUFIJO: trae el
    // indice y el tamaño total en una sola ida y vuelta (cada request al
    // proxy cuesta ~1,7 s, asi que la cantidad de requests manda sobre todo
    // lo demas).
    let cola: Uint8Array;
    let colaBase: number;
    if (this.source instanceof RemoteSource && this.source.size === 0) {
      const r = await this.source.leerCola(COLA_INDICE);
      cola = r.bytes;
      colaBase = r.offset;
    } else {
      const size = this.source.size;
      const colaLen = Math.min(COLA_INDICE, size);
      colaBase = size - colaLen;
      cola = await this.source.read(colaBase, colaLen);
    }
    const colaView = new DataView(cola.buffer, cola.byteOffset, cola.byteLength);

    // Buscar el End Of Central Directory desde el final.
    let eocdRel = -1;
    for (let i = cola.length - 22; i >= 0; i--) {
      if (colaView.getUint32(i, true) === SIG_EOCD) {
        eocdRel = i;
        break;
      }
    }
    if (eocdRel < 0) {
      // Sin indice central: archivo truncado. Se reconstruye escaneando los
      // encabezados locales desde el principio (ver readIndexEscaneando).
      await this.readIndexEscaneando();
      return;
    }

    let centralOffset = colaView.getUint32(eocdRel + 16, true);
    let centralCount = colaView.getUint16(eocdRel + 10, true);
    let centralSize = colaView.getUint32(eocdRel + 12, true);

    // ZIP64: si los campos de 32 bits estan saturados, los valores reales
    // viven en el registro EOCD64 al que apunta el localizador.
    if (centralOffset === 0xffffffff || centralCount === 0xffff || centralSize === 0xffffffff) {
      const locRel = eocdRel - 20;
      if (locRel >= 0 && colaView.getUint32(locRel, true) === SIG_EOCD64_LOC) {
        const eocd64Abs = Number(colaView.getBigUint64(locRel + 8, true));
        const rel = eocd64Abs - colaBase;
        let v: DataView;
        let base: number;
        if (rel >= 0 && rel + 56 <= cola.length) {
          v = colaView;
          base = rel;
        } else {
          const extra = await this.source.read(eocd64Abs, 56);
          v = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
          base = 0;
        }
        if (v.getUint32(base, true) === SIG_EOCD64) {
          centralCount = Number(v.getBigUint64(base + 32, true));
          centralSize = Number(v.getBigUint64(base + 40, true));
          centralOffset = Number(v.getBigUint64(base + 48, true));
        }
      }
    }

    // El directorio central suele caer dentro de la cola que ya bajamos; si
    // es mas grande (muchas entradas), se pide aparte. En cualquier caso es
    // UNA lectura, no una por entrada.
    let central: Uint8Array;
    let centralBase: number;
    if (centralOffset >= colaBase) {
      central = cola;
      centralBase = colaBase;
    } else {
      const len = centralSize > 0 ? centralSize : colaBase - centralOffset;
      central = await this.source.read(centralOffset, len);
      centralBase = centralOffset;
    }
    const cv = new DataView(central.buffer, central.byteOffset, central.byteLength);

    const decoder = new TextDecoder("utf-8");
    let p = centralOffset - centralBase;
    for (let i = 0; i < centralCount; i++) {
      if (p + 46 > central.length || cv.getUint32(p, true) !== SIG_CENTRAL) break;
      const compressionMethod = cv.getUint16(p + 10, true);
      let compressedSize = cv.getUint32(p + 20, true);
      let uncompressedSize = cv.getUint32(p + 24, true);
      const nameLen = cv.getUint16(p + 28, true);
      const extraLen = cv.getUint16(p + 30, true);
      const commentLen = cv.getUint16(p + 32, true);
      let localHeaderOffset = cv.getUint32(p + 42, true);
      const name = decoder.decode(central.subarray(p + 46, p + 46 + nameLen));

      // Campo extra ZIP64 (0x0001): reemplaza los valores saturados, en el
      // mismo orden en que aparecen saturados.
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        let e = p + 46 + nameLen;
        const fin = e + extraLen;
        while (e + 4 <= fin) {
          const id = cv.getUint16(e, true);
          const sz = cv.getUint16(e + 2, true);
          if (id === 0x0001) {
            let q = e + 4;
            if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(cv.getBigUint64(q, true)); q += 8; }
            if (compressedSize === 0xffffffff) { compressedSize = Number(cv.getBigUint64(q, true)); q += 8; }
            if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(cv.getBigUint64(q, true)); }
            break;
          }
          e += 4 + sz;
        }
      }

      this.entries.set(name, {
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }

    if (this.entries.size === 0) await this.readIndexEscaneando();
  }

  /**
   * Reconstruye el indice recorriendo los encabezados LOCALES desde el
   * principio. Se usa cuando el archivo no tiene indice central: en la
   * carpeta real hay .concepts que quedaron truncados (sincronizacion de
   * Concepts interrumpida) y sin esto son 100% irrecuperables. Con esto se
   * rescata todo lo que alcanzo a escribirse, que en la practica incluye la
   * vista previa y el documento.
   *
   * Requiere leer el archivo entero, asi que en una fuente remota se avisa y
   * se cae a descarga completa (no hay forma de saltar sin el indice).
   */
  private async readIndexEscaneando() {
    // Este camino requiere materializar TODO el archivo (no hay indice del
    // que saltar). En una fuente remota eso puede ser un .concepts de hasta
    // 262 MB: sin techo, un archivo truncado o dañado intenta cargarse
    // entero en RAM en un telefono de 1 GB y la pestaña muere sin mensaje.
    // Las fuentes locales (File/Buffer) no tienen este riesgo de red — el
    // usuario ya eligio ese archivo a proposito — asi que el techo solo
    // aplica a RemoteSource.
    if (this.source instanceof RemoteSource) {
      const techo = techoMaterializable();
      if (this.source.size > techo) {
        throw new ArchivoDemasiadoGrandeError(this.source.size, techo);
      }
    }
    const bytes = await this.source.read(0, this.source.size);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder("utf-8");
    let p = 0;
    // El escaneo byte a byte del data descriptor (mas abajo) puede recorrer
    // cientos de millones de posiciones en un archivo grande. Sin ceder el
    // hilo, eso es la UI congelada por segundos enteros en gama baja. Se
    // cede cada CICLO_YIELD iteraciones del bucle externo (una por entrada
    // del zip, normalmente chico) para que el navegador pueda seguir
    // pintando y atendiendo el resto de la app mientras tanto.
    const CICLO_YIELD = 8;
    let ciclo = 0;
    while (p + 30 <= bytes.length) {
      if (view.getUint32(p, true) !== SIG_LOCAL) break;
      const flags = view.getUint16(p + 6, true);
      const compressionMethod = view.getUint16(p + 8, true);
      let compressedSize = view.getUint32(p + 18, true);
      let uncompressedSize = view.getUint32(p + 22, true);
      const nameLen = view.getUint16(p + 26, true);
      const extraLen = view.getUint16(p + 28, true);
      const name = decoder.decode(bytes.subarray(p + 30, p + 30 + nameLen));
      const dataStart = p + 30 + nameLen + extraLen;

      // Con "data descriptor" (bit 3) los tamaños del encabezado vienen en
      // cero y los reales van DESPUES de los datos. Se busca la firma del
      // descriptor validando que el tamaño que declara coincida con la
      // distancia recorrida — asi no se corta en una coincidencia casual
      // dentro del stream comprimido.
      if (compressedSize === 0 && (flags & 0x08) !== 0) {
        let q = dataStart;
        let encontrado = -1;
        let pasos = 0;
        while (q + 16 <= bytes.length) {
          if (view.getUint32(q, true) === SIG_DATA_DESC && view.getUint32(q + 8, true) === q - dataStart) {
            encontrado = q;
            break;
          }
          q++;
          // Ceder tambien DENTRO del escaneo de un solo descriptor: si el
          // stream comprimido de una sola entrada es de decenas de MB, este
          // bucle interno por si solo ya congela el hilo.
          if (++pasos % 2_000_000 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        if (encontrado < 0) break;
        compressedSize = encontrado - dataStart;
        uncompressedSize = view.getUint32(encontrado + 12, true);
        p = encontrado + 16;
      } else {
        p = dataStart + compressedSize;
      }

      if (dataStart + compressedSize > bytes.length) break;
      this.entries.set(name, {
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset: dataStart - 30 - nameLen - extraLen,
      });
      if (++ciclo % CICLO_YIELD === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (this.entries.size === 0) {
      throw new Error("No parece un archivo .concepts valido (no se encontro ninguna entrada)");
    }
  }

  /**
   * Trae por adelantado, en pocas requests, un conjunto de entradas que estan
   * cerca entre si dentro del archivo.
   *
   * Los recursos de un .concepts se guardan contiguos, asi que pedirlos de a
   * uno gasta una ida y vuelta HTTP por recurso (~1,1 s a traves del proxy de
   * Drive): 19 planos = 19 viajes. Agrupando los que caen dentro de una
   * ventana de `maxGrupo` bytes, esos 19 viajes bajan a unos pocos.
   *
   * El tope por grupo existe a proposito: traer los 10 MB de una sola vez
   * seria la menor cantidad de requests posible, pero el usuario no veria
   * NINGUNA imagen hasta que llegara el ultimo byte. Con grupos chicos las
   * fotos siguen apareciendo de a tandas.
   */
  async prefetch(names: string[], maxGrupo = 1024 * 1024): Promise<void> {
    // `names` viene en el orden en que se van a usar (primero lo que ocupa mas
    // pantalla). Ese orden se conserva como PRIORIDAD para decidir que grupo
    // se baja antes.
    const prioridad = new Map<string, number>();
    names.forEach((n, i) => prioridad.set(n, i));

    const tramos = names
      .map((n) => ({ n, e: this.entries.get(n) }))
      .filter((x): x is { n: string; e: ZipEntry } => !!x.e)
      .map(({ n, e }) => ({
        // Margen para el encabezado local (y para el offset corrido).
        desde: Math.max(0, e.localHeaderOffset - 64),
        hasta: e.localHeaderOffset + 30 + 512 + e.compressedSize + 64,
        prio: prioridad.get(n) ?? Number.MAX_SAFE_INTEGER,
      }))
      .sort((a, b) => a.desde - b.desde);
    if (tramos.length === 0) return;

    const grupos: { desde: number; hasta: number; prio: number }[] = [];
    let actual = { ...tramos[0] };
    for (const t of tramos.slice(1)) {
      const fusionado = Math.max(actual.hasta, t.hasta) - actual.desde;
      // Se fusiona si el bloque resultante entra en el tope Y no obliga a
      // bajar un hueco grande de bytes que no se van a usar.
      const hueco = t.desde - actual.hasta;
      if (fusionado <= maxGrupo && hueco <= 256 * 1024) {
        actual.hasta = Math.max(actual.hasta, t.hasta);
        actual.prio = Math.min(actual.prio, t.prio);
      } else {
        grupos.push(actual);
        actual = { ...t };
      }
    }
    grupos.push(actual);

    // Los grupos se agrupan por CERCANIA en el archivo (para gastar pocas
    // requests) pero se bajan por PRIORIDAD. Antes se bajaban en orden de
    // offset, que no tiene nada que ver con lo que el usuario esta mirando:
    // en una conexion lenta el visor esperaba a que llegaran los 10 MB
    // enteros porque el primer plano que necesitaba vivia en el ultimo grupo.
    // Medido con 4G lenta en el dibujo mas pesado: 44,5 s hasta la primera
    // imagen.
    grupos.sort((a, b) => a.prio - b.prio);

    // Secuencial: en paralelo competirian por el ancho de banda y el primer
    // grupo (el que desbloquea las primeras imagenes) llegaria mas tarde.
    //
    // Y con un techo: adelantar mas bytes de los que entran en el cache de
    // bloques es CONTRAPRODUCENTE. Los primeros grupos se desalojan antes de
    // que nadie los lea, y cada recurso termina bajandose dos veces — una en
    // el adelanto y otra al leerlo. Medido sobre el dibujo de 262,9 MB: 386,7
    // MB transferidos, o sea 147% del archivo. Se adelanta solo lo que se va a
    // poder conservar; el resto se lee normalmente, que ya funciona bien.
    const techo = this.source instanceof RemoteSource ? this.source.capacidadCache : Infinity;
    let adelantados = 0;
    for (const g of grupos) {
      const fin = Math.min(g.hasta, this.source.size);
      if (fin <= g.desde) continue;
      const largo = fin - g.desde;
      if (adelantados + largo > techo) break;
      adelantados += largo;
      await this.source.read(g.desde, largo);
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  get(name: string): ZipEntry | undefined {
    return this.entries.get(name);
  }

  /**
   * Lee el encabezado LOCAL de una entrada y devuelve donde arrancan sus
   * datos. El offset declarado deberia ser exacto, pero los .concepts que
   * genera Concepts a veces lo traen corrido un par de bytes: en el dibujo
   * mas pesado de la carpeta (262 MB), 29 de 99 entradas apuntan 2 bytes
   * antes del PK\x03\x04 real. Los unzip de verdad lo toleran buscando la
   * firma cerca; JSZip no, y por eso esos archivos eran imposibles de abrir.
   *
   * Se leen 30+256+64 bytes de una: alcanza para el encabezado, el nombre y
   * el margen de busqueda, sin una segunda request en el caso remoto.
   */
  /**
   * Bytes crudos (todavia comprimidos) de una entrada.
   *
   * Lee el encabezado local Y los datos en UNA sola lectura. Hacerlo en dos
   * (primero el encabezado para saber donde arrancan los datos, despues los
   * datos) duplicaba la cantidad de requests HTTP en el caso remoto, y cada
   * ida y vuelta al proxy cuesta ~1,7 s: con 19 recursos eso eran 19
   * segundos de latencia pura. El costo de leer de mas es ~600 bytes por
   * recurso.
   */
  private async rawData(entry: ZipEntry): Promise<Uint8Array> {
    const margen = 64;
    const prefijo = margen + 30 + 512; // firma + encabezado + nombre/extra
    const desde = Math.max(0, entry.localHeaderOffset - margen);
    const bloque = await this.source.read(desde, prefijo + margen + entry.compressedSize);
    const v = new DataView(bloque.buffer, bloque.byteOffset, bloque.byteLength);
    const rel = entry.localHeaderOffset - desde;

    // El offset declarado deberia ser exacto, pero los .concepts que genera
    // Concepts a veces lo traen corrido un par de bytes: en el dibujo mas
    // pesado de la carpeta (262 MB), 29 de 99 entradas apuntan 2 bytes antes
    // del PK\x03\x04 real. Los unzip de verdad lo toleran buscando la firma
    // cerca; JSZip no, y por eso esos archivos eran imposibles de abrir.
    let encontrado = -1;
    if (rel + 4 <= bloque.length && v.getUint32(rel, true) === SIG_LOCAL) {
      encontrado = rel;
    } else {
      for (let d = 1; d <= margen; d++) {
        if (rel + d + 4 <= bloque.length && v.getUint32(rel + d, true) === SIG_LOCAL) { encontrado = rel + d; break; }
        if (rel - d >= 0 && v.getUint32(rel - d, true) === SIG_LOCAL) { encontrado = rel - d; break; }
      }
    }
    if (encontrado < 0) throw new Error(`Encabezado dañado para ${entry.name}`);

    // Las longitudes se toman del encabezado LOCAL, no del central: los dos
    // traen "extra fields" de distinto largo.
    const nameLen = v.getUint16(encontrado + 26, true);
    const extraLen = v.getUint16(encontrado + 28, true);
    const inicioDatos = encontrado + 30 + nameLen + extraLen;
    const finDatos = inicioDatos + entry.compressedSize;

    // Si el encabezado resulto mas largo que el margen previsto, los ultimos
    // bytes no entraron en el bloque: se completa con una segunda lectura
    // (caso raro, pero no puede devolver datos truncados).
    if (finDatos <= bloque.length) return bloque.subarray(inicioDatos, finDatos);
    return this.source.read(desde + inicioDatos, entry.compressedSize);
  }

  /** Devuelve la entrada descomprimida. Soporta "stored" (0) y "deflate" (8),
   * que es todo lo que usan los .concepts. */
  async read(name: string): Promise<Uint8Array> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`El archivo no contiene ${name}`);
    const raw = await this.rawData(entry);
    if (entry.compressionMethod === 0) return raw;
    if (entry.compressionMethod !== 8) {
      throw new Error(`Compresion no soportada (${entry.compressionMethod}) en ${name}`);
    }
    // `new Response(raw).body` da el ReadableStream directo, sin pasar por
    // un Blob intermedio que nadie necesita (antes: `new Blob([raw]).stream()`
    // — construir el Blob solo para tirar el stream y descartarlo). tree.pack
    // pasa por este camino en cada apertura, y con CPU frenada (bench-cpu-
    // gesto-real.mjs) la construccion de Blobs aparecia con tiempo real.
    const stream = new Response(raw as BodyInit).body!.pipeThrough(new DecompressionStream("deflate-raw"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /** Igual que read() pero devuelve un Blob, sin copia extra cuando la
   * entrada esta guardada sin comprimir (el caso de las fotos y PDFs). */
  async readBlob(name: string, type = ""): Promise<Blob> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`El archivo no contiene ${name}`);
    if (entry.compressionMethod === 0) {
      return new Blob([(await this.rawData(entry)) as BlobPart], { type });
    }
    return new Blob([(await this.read(name)) as BlobPart], { type });
  }
}
