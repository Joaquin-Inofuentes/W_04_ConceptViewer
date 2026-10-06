// Abre ?demo (el dibujo mas pesado) contra un origen REAL de produccion y
// reporta lo que decidio el transporte, cuanto tardo y si la metrica se
// guardo. Deja pasar el INSERT de visor_eventos a proposito (valida las
// columnas nuevas): borrar la fila despues con el sesion_id que imprime.
//
//   node scripts/prod-transporte.mjs "<url con ?demo (y _vercel_share si hace falta)>" [veces=1]

import puppeteer from "puppeteer";

const URL_APP = process.argv[2];
const VECES = Number(process.argv[3] ?? 1);
if (!URL_APP) throw new Error("falta la URL");

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], defaultViewport: { width: 1440, height: 900 }, protocolTimeout: 300_000 });
for (let i = 0; i < VECES; i++) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const o = { drive: 0, nodo: 0, evento: null, estadoEvento: null };
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("concepts-drive") && u.includes("action=download")) o.drive++;
    if (u.includes("trycloudflare.com/descargar")) o.nodo++;
    if (u.includes("/rest/v1/visor_eventos") && r.method() === "POST") {
      try {
        const b = JSON.parse(r.postData() ?? "{}");
        if (b.evento === "abrir") o.evento = b;
      } catch {}
    }
  });
  page.on("response", (r) => {
    if (r.url().includes("/rest/v1/visor_eventos") && r.request().method() === "POST") o.estadoEvento = r.status();
  });
  const t0 = Date.now();
  await page.goto(URL_APP, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.querySelector(".canvas-wrapper canvas"), { timeout: 200_000, polling: 250 }).catch(() => {});
  const msCanvas = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 4000));
  const t = await page.evaluate(() => window.__transporte?.()).catch(() => null);
  console.log(JSON.stringify({ corrida: i + 1, msCanvas, drive: o.drive, nodo: o.nodo, estado: t?.estado, registro: t?.registro?.map((r) => `${r.tipo}:${JSON.stringify(r.detalle)}`), evento: o.evento, estadoInsert: o.estadoEvento }, null, 1));
  await ctx.close();
}
await browser.close();
