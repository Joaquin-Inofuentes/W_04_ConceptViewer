// Audita cada file_id de drive_folder_cache pegandole al proxy con Range de 1
// byte (no descarga el archivo completo). Reporta cuales fallan.
const SUPABASE_URL = "https://kuhcxzusnrttkywgalgk.supabase.co";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1aGN4enVzbnJ0dGt5d2dhbGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NTk5MzQsImV4cCI6MjEwMTUzNTkzNH0.BX2x5jCTR_S68gEcDenwaU3vFBKU4wDyBmmpnPc4ORQ";

const files = JSON.parse(process.argv[2] ? await (await import("node:fs")).promises.readFile(process.argv[2], "utf8") : "[]");

const results = [];
for (const f of files) {
  const url = `${SUPABASE_URL}/functions/v1/concepts-drive?action=download&fileId=${encodeURIComponent(f.file_id)}&range=0-0`;
  try {
    const res = await fetch(url, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    });
    const ok = res.status === 206 || res.status === 200;
    let detalle = "";
    if (!ok) {
      try {
        const body = await res.json();
        detalle = body?.error || "";
      } catch {}
    }
    results.push({ ...f, status: res.status, ok, detalle });
  } catch (e) {
    results.push({ ...f, status: 0, ok: false, detalle: String(e) });
  }
  await new Promise((r) => setTimeout(r, 120));
}

const fallidos = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, fallidos: fallidos.length, detalle_fallidos: fallidos }, null, 2));
