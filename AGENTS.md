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

**Fases**, en orden: `bundle` (src/App.tsx evalúa el módulo, antes del primer
render) → `lista` (src/Gallery/Gallery.tsx:loadFolder, contesta `action=list`)
→ `render` (un frame después de pintar la galería) → `listo()` (src/App.tsx
via onListo de Gallery, la galería ya es usable).

**"Listo" es**: la galería en pantalla, con o sin error de listado. No espera
miniaturas (que siguen en `pendingCount` en segundo plano). Por qué aquí: la
persona puede navegar carpetas enteras sin el error de "tardando más de lo
normal" que aparecería si esperáramos todo.

**Presupuesto**: 30000 ms (W_13_Gateway/lib/apps.ts línea 116). Si no hay
`listo()` ni error de arranque en ese tiempo, el centinela tira `UNX-F2001`
arranque_colgado.

**Códigos** (src/lib/erroresDescarga.ts los mapea, src/VisorConcept/App.tsx
los reporta):
- UNX-F7001: la Edge Function contestó error (real: drive-404, el id murió).
- UNX-F4005: rango no honrado, cae a descarga completa.
- UNX-F4001/F4002/F4003: archivo entero sin RAM, zip roto, otro fallo.

**Recargas**: ninguna en el arranque. El módulo usa AbortSignal.timeout (8-10s
en la galería, pedir a Drive), no UnxCentinela.recargar.

**Topes**: AbortSignal.timeout en src/Gallery/driveClient.ts:listDriveFolder
(8 s, 3 reintentos) y supabaseClient.ts:pedir (10 s, sin reintento).

**Cómo se prueba**: `node _Otros_ArnesParque/arnes.mjs --modulo concept --modo frio`.

**PWA**: no, no tiene service worker propio (inyecta centinela pero no es su
SW). El del gateway (scope "/") se entera del cambio vía contenido.

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
