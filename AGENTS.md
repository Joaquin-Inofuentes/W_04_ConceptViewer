<!-- analizador:inicio -->
# _Otros_Web_CS_ConceptSerializer — el mapa está en `0_MAPA_IA~/`

Antes de explorar el código: `cat 0_MAPA_IA~/IA_00_BRIEF.md`.
Con un bug: `grep -i 'palabra del síntoma' 0_MAPA_IA~/IA_70_SINTOMAS.*`.
Antes de afirmar que algo no existe: `grep -F 'ruta/del/archivo' 0_MAPA_IA~/IA_90_HUECOS*.jsonl`.

De qué partes está hecho (de `0_MAPA_IA~/IA_03_SUBPROYECTOS.jsonl`):

- `web-viewer` · node · raíz `web-viewer` · **el principal**

El campo `sub` de los demás OUTs apunta al `id` de una de esas partes.

El bloque de arranque, los greps y la lista de tools están en el `AGENTS.md` de la
raíz del parque. Una sola copia: dos copias se separan.
<!-- analizador:fin -->

## Contrato de arranque (R2-04, centinela)

Fases, en orden: `bundle` (`src/App.tsx`, al evaluarse el modulo, antes del
primer render) → `lista` (`src/Gallery/Gallery.tsx:loadFolder`, cuando
responde `action=list` de la raiz, sea de red o del cache de Supabase) →
`render` (mismo `loadFolder`, un frame despues de pintar la primera carpeta)
→ `listo()` (`src/App.tsx`, via el `onListo` de `Gallery`). "Dibujo abierto"
es una traza aparte, no un hito de arranque: `fase('dibujo:<fileId>')` en
`openRemote` (`src/App.tsx`).

`listo()` es "la galeria pintada", con o sin error de listado — no espera a
que terminen las miniaturas (eso sigue en `pendingCount`, no bloquea el uso).

Códigos que emite este módulo (`src/lib/erroresDescarga.ts` mapea el error a
uno de estos, `src/VisorConcept/App.tsx` lo reporta con `fallo()`):
- `UNX-F7001` — la Edge Function `concepts-drive` contestó un error propio.
  El caso real es `causa:'drive-404'`: el `fileId` ya no existe en Drive.
- `UNX-F4005` — rango que el proxy no pudo servir (`causa:'drive-sin-rangos'`);
  el cliente cae a la descarga completa a propósito.
- `UNX-F4001` — el archivo hay que bajarlo entero y no entra en el
  presupuesto del dispositivo.
- `UNX-F4002` — encabezado/indice del zip ilegible.
- `UNX-F4003` — cualquier otro fallo al abrir/parsear (default).

`src/lib/centinela.ts` es el wrapper tipado: importar de ahí, nunca de
`window.UnxCentinela` directo.

## `concepts-drive`: el contrato de error (R3-01)

La Edge Function vive en `web-viewer/supabase/functions/concepts-drive/`
(`index.ts` + `errores.ts` + `rangos.ts`) y **no se autodespliega**: después de
editarla hay que redesplegar los TRES archivos con `deploy_edge_function`
(proyecto `kuhcxzusnrttkywgalgk`, `verify_jwt: true`, entrypoint
`concepts-drive/index.ts`). Tests: `deno test` en esa carpeta.

Todo fallo sale con `{ok:false, codigo, causa, detalle, upstreamStatus,
fileId, range, id}` y el MISMO objeto va a `console.error`: el `id` es lo
único que cruza lo que vio la persona con la línea del log de Supabase. El
status dice de quién fue: **400** pedido inválido, **404** el archivo no está
en Drive, **416** el rango no se puede servir, **502** el upstream.

Causas: `pedido-invalido`, `drive-404`, `drive-sin-rangos`, `drive-html`,
`timeout`, `upstream`, `interno`.

**Antes de sospechar de los rangos**: Drive honra los sufijos (`bytes=-N`),
medido el 13/09/2026 en la URL directa y en la confirmada del interstitial.
El 502 que se atribuía a los rangos era un **404 de Drive**: Concepts re-sube
el dibujo, Drive le da un id NUEVO, y el id viejo queda muerto en
`drive_folder_cache` (que la galería sirve sin vencimiento). El síntoma se ve
hoy como `UNX-F7001` + `causa:'drive-404'` y se cura refrescando la carpeta.
