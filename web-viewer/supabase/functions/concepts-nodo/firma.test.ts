import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { firmarDescarga, firmarPedido } from "./firma.ts";
import { RutaInvalida, rutaAbsolutaEnNodo, segmentosDeConcept } from "./ruta.ts";

// Vectores producidos por `firmarDescarga` / `firmarPedido` de
// W_07_Files/packages/contratos/src/firma-descarga.ts con el secreto de
// prueba. Si esta copia deja de coincidir, el nodo contesta 401 a todo.
Deno.test("firma de descarga: mismo vector que @unx/contratos", async () => {
  assertEquals(
    await firmarDescarga("secreto-de-prueba", "C:\\ARQ\\BIM\\Concepts\\A\\x.concepts", 1790000000000),
    "rThJBRaAMI0siy3x_4YjHdiyJhb-D9EeyJUSlemRpio",
  );
});

Deno.test("firma de pedido: mismo vector que @unx/contratos", async () => {
  assertEquals(
    await firmarPedido("secreto-de-prueba", "post", "/listar", 1790000000000),
    "44FqDXefsLXCF-wwvrpESvxVpUBHODc-6JVaQ1sI0Kk",
  );
});

Deno.test("la ruta valida se arma bajo el root del nodo", () => {
  const seg = segmentosDeConcept("Guada y Flor Re/Concepts/ROOSEVELT 4464/3er piso/RO 3er y 4to..concepts");
  assertEquals(rutaAbsolutaEnNodo("C:\\ARQ\\", seg), {
    carpeta: "C:\\ARQ\\BIM\\Concepts\\Guada y Flor Re\\Concepts\\ROOSEVELT 4464\\3er piso",
    archivo: "C:\\ARQ\\BIM\\Concepts\\Guada y Flor Re\\Concepts\\ROOSEVELT 4464\\3er piso\\RO 3er y 4to..concepts",
  });
});

Deno.test("rechaza todo lo que no es un .concepts bajo BIM\\Concepts", () => {
  const malas = [
    "",
    "../../Windows/x.concepts",
    "A/../B/x.concepts",
    "A/./x.concepts",
    "A\\B\\x.concepts",
    "C:/x.concepts",
    "A/x.pdf",
    "A/x.concepts.exe",
    "A//x.concepts",
    "/A/x.concepts",
    "A/x\u0000.concepts",
    "A/x?.concepts",
    "A/B ./x.concepts",
    Array(13).fill("a").join("/") + "/x.concepts",
    "a".repeat(1100) + ".concepts",
  ];
  for (const m of malas) assertThrows(() => segmentosDeConcept(m), RutaInvalida, undefined, JSON.stringify(m));
});

Deno.test("acepta los nombres reales raros de la carpeta", () => {
  for (const ok of [
    "Fede y Franco/Concepts/LP/Artf baño.concepts",
    "Guada y Flor Re/Concepts/ACUÑA DE FIGUEROA 1587/3er Y 4to Piso Electricidad.sync-conflict-20260924-001236-Q4WQSO5.concepts",
    "Guada y Flor Re/Concepts/ACUÑA DE FIGUEROA 1587/..Baños 3er C.concepts",
    "Guada y Flor Re/Concepts/X/RO 3er y 4to..concepts",
  ]) segmentosDeConcept(ok);
});
