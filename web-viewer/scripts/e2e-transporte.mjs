// E2E del "sistema de llamados" en un Chrome real, contra el nodo falso
// (scripts/nodo-falso.mjs) y la Edge Function `concepts-nodo` corriendo local.
// Lo que sale por el lado de DRIVE es el proxy real de produccion: asi el
// respaldo se prueba contra Drive de verdad, no contra un doble.
//
// Cada escenario abre una pagina NUEVA (= "recargar la sesion": el sondeo del
// tunel se decide de cero) y abre el dibujo mas pesado con `?demo`.
//
// Requisitos corriendo antes (ver docs en el commit):
//   node scripts/nodo-falso.mjs
//   SUPABASE_URL=http://127.0.0.1:4181 SUPABASE_ANON_KEY=x UNX_NODO_TOKEN=secreto-de-prueba \
//     deno run --no-check --allow-net --allow-env supabase/functions/concepts-nodo/index.ts
//   npm run dev   (puerto 5173)
//
//   node scripts/e2e-transporte.mjs [escenario ...]

import puppeteer from "puppeteer";

const APP = process.env.APP ?? "http://localhost:5173/concept/";
const NODO = "http://127.0.0.1:4180";
const FN = "http://127.0.0.1:8000";

const ctl = (q) => fetch(`${NODO}/__ctl?${q}`).then((r) => r.json());
const stats = (reset = false) => fetch(`${NODO}/__stats${reset ? "?reset=1" : ""}`).then((r) => r.json());

/**
 * Abre `?demo` en una pagina nueva y espera a que el visor termine de abrir
 * el dibujo (o falle). Devuelve lo observado desde AFUERA: pedidos de red,
 * eventos de metricas y el estado interno del transporte.
 */
async function abrir(browser, { query = "", alVerDescarga } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const obs = { drive: 0, driveBytes: 0, nodo: 0, nodoBytes: 0, eventos: [], errores: [], consola: [] };
  // Bytes que de verdad recibe el navegador del nodo (no los que el nodo lee de disco).
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  const urlDe = new Map();
  cdp.on("Network.requestWillBeSent", (e) => urlDe.set(e.requestId, e.request.url));
  cdp.on("Network.dataReceived", (e) => {
    if ((urlDe.get(e.requestId) ?? "").startsWith(NODO)) obs.nodoBytes += e.dataLength;
  });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    const metodo = req.method();
    // Nada de lo que escribe la app llega a la base real: metricas y miniaturas se capturan y se contestan 201.
    if (metodo !== "GET" && metodo !== "OPTIONS" && url.includes("/rest/v1/")) {
      if (url.includes("visor_eventos")) {
        try {
          obs.eventos.push(JSON.parse(req.postData() ?? "{}"));
        } catch {
          /* cuerpo ilegible */
        }
      }
      return req.respond({ status: 201, body: "" });
    }
    if (url.includes("/functions/v1/concepts-drive") && url.includes("action=download")) obs.drive++;
    if (url.startsWith(`${NODO}/descargar`)) {
      obs.nodo++;
      alVerDescarga?.(obs.nodo);
    }
    req.continue();
  });
  page.on("response", async (res) => {
    if (res.url().includes("/functions/v1/concepts-drive") && res.url().includes("action=download")) {
      const l = Number(res.headers()["content-length"] ?? 0);
      obs.driveBytes += l;
    }
  });
  page.on("pageerror", (e) => obs.errores.push(e.message));
  page.on("console", (m) => obs.consola.push(`${m.type()}: ${m.text().slice(0, 160)}`));

  const t0 = Date.now();
  await page.goto(`${APP}?demo&nodoApi=${encodeURIComponent(FN)}${query}`, { waitUntil: "domcontentloaded" });
  // "Abrio" = el visor dibujo, o mostro un error. Lo que pase primero.
  const resultado = await page
    .waitForFunction(
      () => {
        if (document.querySelector(".canvas-wrapper canvas")) return "canvas";
        const err = document.querySelector(".viewer-error, .error-message, [role=alert]");
        return err ? "error:" + err.textContent : false;
      },
      { timeout: 150_000, polling: 250 },
    )
    .then((h) => h.jsonValue())
    .catch(() => "timeout");
  obs.msHastaCanvas = Date.now() - t0;
  obs.resultado = resultado;
  // Un respiro para que lleguen las lecturas en vuelo y el evento `abrir`.
  await new Promise((r) => setTimeout(r, 2500));
  obs.transporte = await page.evaluate(() => window.__transporte?.()).catch(() => null);
  await context.close();
  return obs;
}

const comprobaciones = [];
function chequear(nombre, ok, detalle = "") {
  comprobaciones.push({ nombre, ok });
  console.log(`   ${ok ? "OK  " : "FALLA"} ${nombre}${detalle ? `  (${detalle})` : ""}`);
}

const ESCENARIOS = {
  async "tunel-sano"(b) {
    await ctl("modo=normal");
    await stats(true);
    const o = await abrir(b);
    const s = await stats();
    chequear("el dibujo abre", o.resultado === "canvas", `${o.msHastaCanvas} ms`);
    chequear("modo del sondeo = tunel", o.transporte?.estado?.modo === "tunel", `rtt ${o.transporte?.estado?.rttMs} ms`);
    chequear("los bytes salieron del nodo", s.descargas > 0 && o.nodo > 0, `${s.descargas} rangos, ${(s.bytes / 1048576).toFixed(1)} MB`);
    chequear("CERO descargas del proxy de Drive", o.drive === 0, `${o.drive}`);
    chequear("el navegador NO hizo preflight con Range (CORS)", s.preflightsConRange === 0, `${s.preflights} preflights`);
    chequear("solo se pidio una fraccion del archivo", s.bytes < 40 * 1048576, `${(s.bytes / 1048576).toFixed(1)} MB de 262,9`);
    const ev = o.eventos.find((e) => e.evento === "abrir");
    chequear("la metrica `abrir` dice transporte=tunel con ms_apertura", ev?.transporte === "tunel" && typeof ev?.ms_apertura === "number" && ev?.exito === true, JSON.stringify(ev));
    return o;
  },
  async "nodo-caido-desde-el-inicio"(b) {
    await ctl("modo=caido");
    await stats(true);
    const o = await abrir(b);
    chequear("el dibujo abre igual (por Drive)", o.resultado === "canvas", `${o.msHastaCanvas} ms`);
    chequear("modo del sondeo = drive", o.transporte?.estado?.modo === "drive", o.transporte?.estado?.motivo);
    chequear("hubo descargas de Drive y ninguna del nodo", o.drive > 0 && o.nodo === 0, `drive ${o.drive}, nodo ${o.nodo}`);
    const ev = o.eventos.find((e) => e.evento === "abrir");
    chequear("la metrica dice transporte=drive", ev?.transporte === "drive", ev?.transporte_motivo);
    await ctl("modo=normal");
    return o;
  },
  async "sin-nodos-en-la-flota"(b) {
    await ctl("modo=sinnodos");
    const o = await abrir(b);
    chequear("abre por Drive", o.resultado === "canvas" && o.drive > 0 && o.nodo === 0, `${o.msHastaCanvas} ms`);
    chequear("motivo = sin-nodos", o.transporte?.estado?.motivo === "sin-nodos", o.transporte?.estado?.motivo);
    await ctl("modo=normal");
    return o;
  },
  async "nodo-no-operativo"(b) {
    await ctl("modo=saludmala");
    const o = await abrir(b);
    chequear("abre por Drive", o.resultado === "canvas" && o.drive > 0 && o.nodo === 0, `${o.msHastaCanvas} ms`);
    // La funcion ya descarta un nodo `operativo:false` del lado servidor.
    chequear("motivo = tunel-no-responde (lo filtra la funcion)", o.transporte?.estado?.motivo === "tunel-no-responde", o.transporte?.estado?.motivo);
    await ctl("modo=normal");
    return o;
  },
  async "el-navegador-no-llega-al-tunel (CORS)"(b) {
    // El servidor SI llega al tunel (la funcion lo da por bueno) pero este
    // navegador no: origen fuera de la lista, red corporativa, VPN... El
    // sondeo directo desde el navegador es lo que lo detecta.
    await ctl("modo=normal&origenes=http://otro.example");
    await stats(true);
    const o = await abrir(b);
    chequear("abre por Drive", o.resultado === "canvas" && o.drive > 0 && o.nodo === 0, `${o.msHastaCanvas} ms`);
    chequear("el sondeo del navegador lo detecto (sonda-fallo)", o.transporte?.estado?.motivo === "sonda-fallo", o.transporte?.estado?.motivo);
    await ctl("modo=normal&origenes=http://localhost:5173,http://127.0.0.1:5173");
    return o;
  },
  async "forzado-a-drive"(b) {
    await ctl("modo=normal");
    await stats(true);
    const o = await abrir(b, { query: "&transporte=drive" });
    chequear("abre por Drive sin tocar el nodo", o.resultado === "canvas" && o.drive > 0 && o.nodo === 0 && (await stats()).salud === 0, `${o.msHastaCanvas} ms`);
    return o;
  },
  async "tunel-muere-a-mitad-de-lectura"(b) {
    await ctl("modo=normal");
    await stats(true);
    let cortado = false;
    const o = await abrir(b, {
      // Despues del 2do rango el nodo "se cae": el resto de la lectura tiene que seguir por Drive.
      alVerDescarga: (n) => {
        if (n === 3 && !cortado) {
          cortado = true;
          void ctl("modo=caido");
        }
      },
    });
    chequear("el dibujo abre igual", o.resultado === "canvas", `${o.msHastaCanvas} ms`);
    chequear("empezo por el nodo y termino por Drive", o.nodo > 0 && o.drive > 0, `nodo ${o.nodo}, drive ${o.drive}`);
    chequear("se registro la conmutacion", !!o.transporte?.registro?.some((r) => r.tipo === "conmutacion"));
    chequear("el modo global quedo en caido", /^caido:lectura/.test(o.transporte?.estado?.motivo ?? ""), o.transporte?.estado?.motivo);
    const ev = o.eventos.find((e) => e.evento === "abrir");
    chequear("la metrica termina con transporte=drive", ev?.transporte === "drive", JSON.stringify(ev));
    await ctl("modo=normal");
    return o;
  },
  async "nodo-rechaza-las-firmas"(b) {
    await ctl("modo=expirar");
    const o = await abrir(b);
    chequear("abre por Drive (permisos rechazados -> respaldo)", o.resultado === "canvas" && o.drive > 0, `${o.msHastaCanvas} ms`);
    await ctl("modo=normal");
    return o;
  },
  async "nodo-ignora-Range"(b) {
    await ctl("modo=sinrangos");
    await stats(true);
    const o = await abrir(b);
    const s = await stats();
    chequear("abre por Drive", o.resultado === "canvas" && o.drive > 0, `${o.msHastaCanvas} ms`);
    chequear("el navegador NO recibio el archivo entero del nodo", o.nodoBytes < 100 * 1048576, `recibio ${(o.nodoBytes / 1048576).toFixed(1)} MB (el nodo leyo ${(s.bytes / 1048576).toFixed(1)} MB de disco)`);
    await ctl("modo=normal");
    return o;
  },
  async "tunel-corta-el-cuerpo"(b) {
    await ctl("modo=corta");
    const o = await abrir(b);
    chequear("abre por Drive (cuerpo incompleto no se acepta)", o.resultado === "canvas" && o.drive > 0, `${o.msHastaCanvas} ms`);
    await ctl("modo=normal");
    return o;
  },
};

const elegidos = process.argv.slice(2);
const nombres = elegidos.length ? elegidos : Object.keys(ESCENARIOS);
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 300_000,
});
try {
  for (const n of nombres) {
    if (!ESCENARIOS[n]) throw new Error(`escenario desconocido: ${n}`);
    console.log(`\n== ${n}`);
    const o = await ESCENARIOS[n](browser);
    if (o.errores.length) console.log(`   (errores de pagina: ${o.errores.slice(0, 3).join(" | ")})`);
    if (comprobaciones.at(-1) && !comprobaciones.slice(-1)[0].ok) console.log("   consola:", o.consola.slice(-6));
  }
} finally {
  await ctl("modo=normal").catch(() => {});
  await browser.close();
}
const malas = comprobaciones.filter((c) => !c.ok);
console.log(`\n${comprobaciones.length - malas.length}/${comprobaciones.length} comprobaciones OK`);
process.exit(malas.length ? 1 : 0);
