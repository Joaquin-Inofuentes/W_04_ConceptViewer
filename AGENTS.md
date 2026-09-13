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
- `UNX-F4005` — rango a `concepts-drive` que fallo (el 502 conocido; R3-01 lo
  arregla, esto solo evita que el visor se cuelgue).
- `UNX-F4001` — el archivo hay que bajarlo entero y no entra en el
  presupuesto del dispositivo.
- `UNX-F4002` — encabezado/indice del zip ilegible.
- `UNX-F4003` — cualquier otro fallo al abrir/parsear (default).

`src/lib/centinela.ts` es el wrapper tipado: importar de ahí, nunca de
`window.UnxCentinela` directo.
