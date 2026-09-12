// ============================================================================
//  escucha-accesos.js — registra UN ingreso y UN egreso por visita.
//
//  Fuente canónica: C:\.TBT\Proyectos\_Otros_Escuchas\escucha-accesos.js
//  Se copia VERBATIM a cada web. Si hay que arreglar algo, se arregla acá y se
//  vuelve a copiar (`copiar.ps1`). Dos copias divergentes es exactamente el
//  problema que esto viene a resolver.
//
//  Integración, dos líneas:
//      <script src="/escucha-accesos.js" data-proyecto="visor3d"></script>
//
//  Y cuando la app sepa quién es la persona (después del login, del prompt de
//  nombre, de lo que sea):
//      window.UnxEscucha.identificar("Joaco");
//
//  Por qué hace falta ese segundo paso: el ingreso no se puede mandar en el
//  `load` porque en ese momento casi ninguna app sabe todavía quién entró. La
//  escucha espera el nombre hasta ESPERA_MAX_MS y recién ahí manda; si nunca
//  llega, manda igual como "sin nombre", porque un ingreso anónimo sigue
//  siendo un ingreso y perderlo sería peor.
//
//  No mide nada más. Ni clics, ni pantallas, ni tiempo: sólo entró y salió.
// ============================================================================
(function () {
  "use strict";

  if (window.UnxEscucha) return;             // idempotente: dos <script> no duplican

  var BASE = "https://epjmrzhsothbyvmbsymb.supabase.co/rest/v1/rpc/";
  // Dos puertas para la MISMA función. `registrar_acceso` toma parámetros con
  // nombre y necesita `application/json`; `acceso` toma el cuerpo crudo y es la
  // única que sirve para sendBeacon, que sólo sabe mandar `text/plain`.
  var ENDPOINT = BASE + "registrar_acceso";
  var ENDPOINT_BEACON = BASE + "acceso";
  var ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVwam1yemhzb3RoYnl2bWJzeW1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1NzUzOTAsImV4cCI6MjEwMTE1MTM5MH0._3gBWXHR4QAd5ddwuPM_nmuJEcor4xT6rqJH1Q1inRI";
  // Token público a propósito: sólo habilita a INSERTAR un ingreso o un egreso.
  // La tabla tiene RLS sin policies — con esta clave no se lee ni una fila.
  var TOKEN = "2WZrtvhggP6JOQopdsQTLLFA7tMISBYY";
  // Sin nombre a la vista, cuánto se espera antes de mandar el ingreso igual.
  var ESPERA_MAX_MS = 12000;
  // Con un nombre "de pista" (la URL, el localStorage), cuánto se le da a la
  // app para corregirlo con identificar(). Ver `programarIngreso`.
  var GRACIA_MS = 2500;

  // ── Config: del atributo del <script>, o de window.UNX_ESCUCHA ───────────
  var script = document.currentScript ||
    (function () {
      var s = document.querySelectorAll('script[data-proyecto]');
      return s.length ? s[s.length - 1] : null;
    })();
  var cfg = window.UNX_ESCUCHA || {};
  var PROYECTO = (script && script.getAttribute("data-proyecto")) || cfg.proyecto || "";
  var ORIGEN = (script && script.getAttribute("data-origen")) || cfg.origen || "web";

  if (!PROYECTO) {
    console.warn("[escucha] falta data-proyecto: no se registra nada");
    return;
  }

  // ── Sesión ───────────────────────────────────────────────────────────────
  //  Vive en sessionStorage: una pestaña = una visita. Con localStorage, dos
  //  pestañas abiertas compartirían sesión y el antirrebote del servidor se
  //  comería el ingreso de la segunda.
  var SES_KEY = "unx_escucha_sesion";
  var sesion;
  try {
    sesion = sessionStorage.getItem(SES_KEY);
    if (!sesion) {
      sesion = (crypto && crypto.randomUUID ? crypto.randomUUID()
        : String(Date.now()) + "-" + Math.random().toString(16).slice(2));
      sessionStorage.setItem(SES_KEY, sesion);
    }
  } catch (e) {
    // Modo privado o storage bloqueado: sesión sólo en memoria. Se pierde el
    // pareo ingreso/egreso entre recargas, pero los dos eventos igual entran.
    sesion = String(Date.now()) + "-" + Math.random().toString(16).slice(2);
  }

  // ── Quién ────────────────────────────────────────────────────────────────
  //  Cada app guarda el nombre con una clave distinta. En vez de pedirle a
  //  cada una que se adapte, la escucha conoce las que ya existen en el parque.
  //  Estas son las claves REALES que hay hoy en el parque, no una lista de
  //  nombres probables. Las que viven en IndexedDB (Portal, Métricas, CODY,
  //  Llaves) no se pueden leer desde acá sin abrir la base a mano: esas apps
  //  llaman a identificar() y listo.
  var CLAVES = [
    "mip_username",                  // Visor 3D
    "conceptserializer_user_name",   // Concept
    "recuperador.nombre",            // Versiones
    "unx_user_name", "user_name", "usuario",  // genéricas, por si aparece otra
  ];

  function leerNombreSincrono() {
    // 1. Lo que la app ya nos dijo.
    if (window.UNX_USUARIO) return String(window.UNX_USUARIO);
    // 2. El que inyecta el portal al abrir la app.
    try {
      var q = new URLSearchParams(location.search).get("unx_name");
      if (q && q.trim()) return q.trim();
    } catch (e) { /* URL rara */ }
    // 3. Los almacenes que ya usan las apps del parque.
    for (var i = 0; i < CLAVES.length; i++) {
      try {
        var v = localStorage.getItem(CLAVES[i]) || sessionStorage.getItem(CLAVES[i]);
        if (!v) continue;
        v = v.trim();
        // Varias apps guardan JSON ("\"Joaco\"" o {"nombre":"Joaco"}).
        if (v.charAt(0) === '"' || v.charAt(0) === "{") {
          try {
            var j = JSON.parse(v);
            v = typeof j === "string" ? j : (j.nombre || j.usuario || j.user_name || j.name || "");
          } catch (e2) { /* no era JSON: queda el crudo */ }
        }
        if (v && v.trim()) return v.trim();
      } catch (e) { /* storage bloqueado */ }
    }
    return null;
  }

  // ── Envío ────────────────────────────────────────────────────────────────
  function cuerpo(tipo, usuario) {
    return JSON.stringify({
      p_token: TOKEN,
      p_usuario: usuario || "sin nombre",
      p_proyecto: PROYECTO,
      p_tipo: tipo,
      p_url: String(location.href).slice(0, 500),
      p_sesion: sesion,
      p_origen: ORIGEN,
      p_ua: (navigator.userAgent || "").slice(0, 300),
    });
  }

  function mandar(tipo, usuario, conBeacon) {
    var body = cuerpo(tipo, usuario);
    // El egreso va por sendBeacon: es lo único que el navegador garantiza
    // entregar cuando la pestaña se está cerrando. `fetch` con keepalive es el
    // plan B; un fetch normal se cancela y la salida se pierde.
    if (conBeacon && navigator.sendBeacon) {
      try {
        // sendBeacon no deja poner cabeceras: la apikey va por query y el
        // cuerpo como text/plain, que además evita el preflight que un beacon
        // no puede hacer. Por eso pega contra `acceso` y no contra
        // `registrar_acceso` (esa, con text/plain, devuelve PGRST202).
        var ok = navigator.sendBeacon(
          ENDPOINT_BEACON + "?apikey=" + encodeURIComponent(ANON),
          new Blob([body], { type: "text/plain;charset=UTF-8" })
        );
        if (ok) return;
      } catch (e) { /* cae al fetch */ }
    }
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: ANON, authorization: "Bearer " + ANON },
        body: body,
        keepalive: true,
        mode: "cors",
      }).catch(function () { /* registrar nunca debe romper la app */ });
    } catch (e) { /* idem */ }
  }

  // ── Máquina de estados: un ingreso y un egreso, ni uno más ───────────────
  var entro = false, salio = false, temporizador = null;

  function registrarIngreso(usuario) {
    if (entro) return;
    entro = true;
    if (temporizador) { clearTimeout(temporizador); temporizador = null; }
    mandar("ingreso", usuario, false);
  }

  /**
   * El nombre que se ve al arrancar es una PISTA, no la verdad: la app puede
   * corregirlo enseguida. Llaves, por ejemplo, ignora el `?unx_name=` de la
   * URL cuando ya tiene una persona guardada — y así el ingreso salía con un
   * nombre y el egreso, ya corregido, con otro. La misma visita quedaba
   * partida en dos personas.
   *
   * Por eso el ingreso con pista se demora GRACIA_MS. Si identificar() llega
   * en ese rato, manda el nombre bueno; si no llega, manda la pista, que
   * sigue siendo mejor que nada.
   */
  function programarIngreso(pista) {
    if (entro || temporizador) return;
    temporizador = setTimeout(function () {
      temporizador = null;
      registrarIngreso(pista);
    }, GRACIA_MS);
  }

  function registrarEgreso() {
    if (salio) return;
    // Si se va antes de que sepamos el nombre, igual queda el egreso: sin él,
    // la sesión aparece abierta para siempre.
    if (!entro) registrarIngreso(leerNombreSincrono());
    salio = true;
    mandar("egreso", leerNombreSincrono(), true);
  }

  // API para la app: avisar quién es en cuanto se sepa.
  window.UnxEscucha = {
    identificar: function (nombre) {
      if (nombre && String(nombre).trim()) window.UNX_USUARIO = String(nombre).trim();
      registrarIngreso(window.UNX_USUARIO);
    },
    egreso: registrarEgreso,
    sesion: sesion,
    proyecto: PROYECTO,
  };

  // Si el nombre ya está a mano, se manda ya. Si no, se espera a que la app
  // llame a identificar(), con tope.
  var pista = leerNombreSincrono();
  if (pista) {
    programarIngreso(pista);
  } else {
    temporizador = setTimeout(function () {
      temporizador = null;
      registrarIngreso(leerNombreSincrono());
    }, ESPERA_MAX_MS);
  }

  // ── Salida ───────────────────────────────────────────────────────────────
  //  `pagehide` y no `beforeunload`: en iOS y en Android `beforeunload` no
  //  dispara al cerrar la pestaña. `visibilitychange: hidden` cubre el caso de
  //  que el sistema mate la pestaña en segundo plano sin avisar. El
  //  antirrebote del servidor se encarga de que los dos juntos no dupliquen.
  window.addEventListener("pagehide", registrarEgreso);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") registrarEgreso();
  });
})();
