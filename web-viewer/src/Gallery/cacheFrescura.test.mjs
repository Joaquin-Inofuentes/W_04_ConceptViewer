// node --test src/Gallery/cacheFrescura.test.mjs
//
// Mismo patron que src/lib/erroresDescarga.test.mjs: Node 24 corre TypeScript
// con sintaxis erasable sin flags, asi que este test importa el modulo
// publicado tal cual. Se importa `cacheFrescura.ts` (no `supabaseClient.ts`,
// que lo re-exporta) porque ese ultimo arrastra `../config` con un import sin
// extension: Vite lo resuelve, pero la resolucion ESM estricta de
// `node --test` no — ver el comentario de `cacheFrescura.ts`.
import test from "node:test";
import assert from "node:assert/strict";
import { cacheDeCarpetaVencido, TTL_CACHE_CARPETA_MS } from "./cacheFrescura.ts";

test("una fila recien actualizada no esta vencida", () => {
  assert.equal(cacheDeCarpetaVencido({ updated_at: new Date().toISOString() }), false);
});

test("una fila de hace 1 minuto no esta vencida", () => {
  const haceUnMinuto = new Date(Date.now() - 60_000).toISOString();
  assert.equal(cacheDeCarpetaVencido({ updated_at: haceUnMinuto }), false);
});

test("una fila justo en el borde del TTL todavia no esta vencida", () => {
  const enElBorde = new Date(Date.now() - TTL_CACHE_CARPETA_MS + 1000).toISOString();
  assert.equal(cacheDeCarpetaVencido({ updated_at: enElBorde }), false);
});

test("una fila que paso el TTL esta vencida (el caso de C-15/R3-01)", () => {
  // La fila real que causo el bug: `updated_at` de dos dias antes de que
  // Concepts re-subiera el archivo con un id nuevo en Drive.
  const hace2Dias = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(cacheDeCarpetaVencido({ updated_at: hace2Dias }), true);
});

test("justo un instante despues del TTL ya esta vencida", () => {
  const pasadoElBorde = new Date(Date.now() - TTL_CACHE_CARPETA_MS - 1000).toISOString();
  assert.equal(cacheDeCarpetaVencido({ updated_at: pasadoElBorde }), true);
});

test("un updated_at invalido (fila corrupta o formato inesperado) se trata como vencido", () => {
  assert.equal(cacheDeCarpetaVencido({ updated_at: "no-es-una-fecha" }), true);
});

test("el TTL es de 6 horas", () => {
  assert.equal(TTL_CACHE_CARPETA_MS, 6 * 60 * 60 * 1000);
});
