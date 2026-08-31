// Navega la galeria como un usuario: entra a una carpeta con dibujos, espera
// las miniaturas y saca una captura. Sirve para comprobar que las miniaturas
// cacheadas se ven bien (no borrosas ni vacias) y que navegar es instantaneo.
//
//   node scripts/e2e-galeria.mjs ["Nombre/De/La/Carpeta"]

import path from "node:path";
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer";

// Apunta a produccion con BASE_URL=https://... ; por defecto, el dev server.
const RAIZ = process.env.BASE_URL || "http://localhost:5173";
const DEV_URL = RAIZ.endsWith("/") ? RAIZ : RAIZ + "/";
const CACHE_DIR = path.resolve(".cache/concepts");
const ruta = (process.argv[2] || "Guada y Flor Re/Concepts/ROOSEVELT 4464/3er piso").split("/");

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 2 },
  protocolTimeout: 180000,
});
const page = await browser.newPage();
const errores = [];
page.on("pageerror", (e) => errores.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errores.push(m.text().slice(0, 200)); });

const t0 = Date.now();
await page.goto(DEV_URL, { waitUntil: "networkidle2" });
for (const b of await page.$$("button")) {
  const t = await page.evaluate((el) => el.textContent, b);
  if (t && t.includes("sin nombre")) { await b.click(); break; }
}
await page.waitForSelector(".gallery-card", { timeout: 60000 });
console.log(`raiz de la galeria lista en ${Date.now() - t0}ms`);

for (const nombre of ruta) {
  const tNav = Date.now();
  // La carpeta destino puede tardar un instante en aparecer en la grilla
  // despues de que se actualiza el breadcrumb.
  await page.waitForFunction(
    (n) => [...document.querySelectorAll(".folder-card .gallery-name")].some((e) => e.textContent === n),
    { timeout: 60000, polling: 100 },
    nombre
  );
  const ok = await page.evaluate((n) => {
    const c = [...document.querySelectorAll(".folder-card")].find(
      (e) => e.querySelector(".gallery-name")?.textContent === n
    );
    if (!c) return false;
    c.click();
    return true;
  }, nombre);
  if (!ok) throw new Error(`no se encontro la carpeta "${nombre}"`);
  await page.waitForFunction(
    (n) => {
      const crumbs = [...document.querySelectorAll(".gallery-breadcrumb-item")].map((e) => e.textContent);
      return crumbs[crumbs.length - 1] === n;
    },
    { timeout: 60000 },
    nombre
  );
  console.log(`  -> ${nombre}: ${Date.now() - tNav}ms`);
}

// Esperar a que termine de cargar el listado (fuera del estado skeleton) y a
// que no queden miniaturas pendientes de generar.
await page.waitForFunction(
  () => !document.querySelector(".gallery-card.skeleton") && !document.querySelector(".gallery-status"),
  { timeout: 300000, polling: 500 }
);

const info = await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".gallery-grid:not(.gallery-folders-grid) .gallery-card")];
  return {
    archivos: cards.length,
    conMiniatura: cards.filter((c) => c.querySelector("img")).length,
    conError: cards.filter((c) => c.querySelector(".gallery-thumb-error")).length,
    resoluciones: [...new Set(cards.map((c) => {
      const i = c.querySelector("img");
      return i ? `${i.naturalWidth}x${i.naturalHeight}` : "sin-img";
    }))],
    mostradoA: (() => {
      const i = document.querySelector(".gallery-thumb img");
      return i ? `${Math.round(i.getBoundingClientRect().width)}px` : null;
    })(),
    nombres: cards.map((c) => c.querySelector(".gallery-name")?.textContent),
  };
});
console.log(`\n${JSON.stringify(info, null, 2)}`);

const shot = path.join(CACHE_DIR, "e2e-galeria.png");
// `CACHE_DIR` puede no existir todavia (los otros scripts de la suite lo
// crean via crawl-drive.mjs, que este test no necesita para lo que prueba):
// sin esto, un ambiente limpio hacia fallar el screenshot con ENOENT
// DESPUES de que la navegacion y las miniaturas ya habian pasado.
await mkdir(CACHE_DIR, { recursive: true });
await page.screenshot({ path: shot });
console.log(`\ncaptura: ${shot}`);
console.log(errores.length ? `errores: ${[...new Set(errores)].slice(0, 5).join(" | ")}` : "sin errores en consola");

await browser.close();
