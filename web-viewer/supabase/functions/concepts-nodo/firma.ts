// Firmas HMAC que el nodo (`_FilesSync`) acepta. Es la MISMA construccion que
// `firma-descarga.ts` de W_07_Files/packages/contratos (el mensaje y el
// alfabeto tienen que ser identicos byte a byte, si no el nodo contesta 401),
// copiada porque esta funcion corre en Deno y no puede importar ese paquete.
// `firma.test.ts` fija un vector contra el valor que produce el original.

const SEPARADOR = "|";
const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function aBase64Url(bytes: ArrayBuffer): string {
  const datos = new Uint8Array(bytes);
  let salida = "";
  for (let i = 0; i < datos.length; i += 3) {
    const a = datos[i]!;
    const b = datos[i + 1];
    const c = datos[i + 2];
    salida += ALFABETO[a >> 2];
    salida += ALFABETO[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    salida += ALFABETO[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    salida += ALFABETO[c & 63];
  }
  return salida;
}

async function firmar(secreto: string, mensaje: string): Promise<string> {
  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return aBase64Url(await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(mensaje)));
}

/** Permiso de descarga: vale para UNA ruta hasta `expiraEnMs`. */
export function firmarDescarga(secreto: string, rutaAbsoluta: string, expiraEnMs: number): Promise<string> {
  return firmar(secreto, [String(expiraEnMs), rutaAbsoluta, "", "", "attachment"].join(SEPARADOR));
}

/** Firma de un pedido (listar) por el header X-Unx-Sig. */
export function firmarPedido(secreto: string, metodo: string, ruta: string, expiraEnMs: number): Promise<string> {
  return firmar(secreto, [metodo.toUpperCase(), ruta, String(expiraEnMs), ""].join(SEPARADOR));
}
