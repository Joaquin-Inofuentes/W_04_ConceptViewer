import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // `pdfjs-dist` solo se importa dentro de `raster.worker.ts` (un Worker),
    // nunca desde el hilo principal. El escaneo inicial de dependencias de
    // Vite arranca desde `index.html` y en la practica no llega a rastrear
    // esa importacion hasta que el worker de verdad se ejecuta -- que pasa
    // recien cuando se abre el PRIMER dibujo con un PDF embebido. En ese
    // momento Vite descubre la dependencia nueva "sobre la marcha", interrumpe
    // el pre-bundle en curso y sirve 504 ("Outdated Optimize Dep") a cualquier
    // request que ya estuviera en vuelo con el hash viejo. Con 6+ PDFs
    // pidiendose en paralelo (uno por worker), CADA uno pisa esa carrera:
    // "worker de rasterizado caido" x3-4 en menos de un minuto, el circuit
    // breaker de `renderCore.ts` apaga el pool de workers 5 minutos, y el
    // dibujo se queda sin ninguna imagen (reproducido con
    // "Iluminación fallido.concepts": las 6 laminas del plano nunca
    // aparecian, solo timeouts). Declararla aca fuerza a Vite a pre-bundlear
    // pdfjs-dist ANTES de que el navegador pida nada, asi el primer dibujo
    // con PDFs ya encuentra el bundle listo. No hace falta en produccion
    // (`vite build` no tiene esta fase de descubrimiento en caliente), pero
    // sin esto CUALQUIER sesion de `npm run dev` que abra un .concepts con
    // PDFs como primer gesto se topa con este bug.
    include: ["pdfjs-dist"],
  },
  build: {
    // Objetivo minimo real: sin esto Vite 8 usa "baseline-widely-available"
    // (muy moderno) por defecto. La app declara soportar telefonos de gama
    // baja (Android WebView viejo, iOS Safari 14) via device.ts, pero eso
    // nunca se verifico contra el TARGET DE BUILD -- solo contra el
    // comportamiento en Chrome de escritorio con throttling. Si el WebView
    // real no entiende la sintaxis emitida, la app da pantalla en blanco sin
    // que ningun test lo detecte. `tsconfig.app.json` declara target es2023
    // pero tiene `noEmit: true`, o sea que NO afecta el output: solo tipa.
    target: ['chrome87', 'safari14', 'es2020'],
  },
  server: {
    watch: {
      // `.cache/` guarda el corpus de .concepts (varios GB), las capturas de
      // los tests y los perfiles de Chrome que levanta Puppeteer. Vigilarlo no
      // sirve para nada y ademas ROMPE el dev server: en cuanto un test crea su
      // perfil de Chrome ahi adentro, el watcher intenta seguir
      // `Default/Network/Cookies-journal`, Windows lo tiene bloqueado y vite se
      // cae con EBUSY. O sea que correr la bateria mataba el servidor contra el
      // que estaba corriendo.
      ignored: ['**/.cache/**'],
    },
  },
})
