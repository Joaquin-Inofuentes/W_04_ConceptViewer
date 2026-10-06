# Carga en Supabase (proyecto bim-assistant) el secret que la funcion
# `concepts-nodo` usa para firmar los permisos al nodo. Es el MISMO valor que
# UNX_NODO_TOKEN de Files (Vercel, proyecto w_07_files). Lo corre el dueño: el
# valor nunca pasa por el chat ni se escribe en ningun archivo.
#
#   1. Vercel > w_07_files > Settings > Environment Variables > UNX_NODO_TOKEN (copiar)
#   2. powershell -File scripts\CONFIGURAR_SECRETO_NODO.ps1
#   3. node scripts\medir-transporte.mjs 3     (compara tunel vs Drive)

$ref = "kuhcxzusnrttkywgalgk"
$token = Read-Host "Pega UNX_NODO_TOKEN" -AsSecureString
$plano = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($token))
if (-not $plano) { throw "vacio" }
supabase secrets set "UNX_NODO_TOKEN=$plano" --project-ref $ref
Remove-Variable plano
Write-Host "Listo. Verificar: ...functions/v1/concepts-nodo?action=estado debe decir firma:true"
