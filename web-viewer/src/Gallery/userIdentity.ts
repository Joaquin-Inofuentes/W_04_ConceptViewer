const KEY = "conceptserializer_user_name";

export function getUserName(): string | null {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
  } catch {
    // localStorage no disponible: seguimos igual, probamos el query param.
  }
  // Si todavía no hay nombre guardado, el portal (unx-portal.vercel.app)
  // puede inyectar el que la persona ya tipeó ahí, vía ?unx_name=, para no
  // pedirlo de nuevo acá. Se persiste igual que si viniera del NamePrompt.
  try {
    const injected = new URLSearchParams(window.location.search).get("unx_name");
    if (injected && injected.trim().length >= 2) {
      const clean = injected.trim().slice(0, 60);
      setUserName(clean);
      return clean;
    }
  } catch {
    // sin URLSearchParams o sin window: seguimos sin nombre.
  }
  return null;
}

export function setUserName(name: string): void {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // localStorage no disponible (modo privado, etc.): seguimos sin persistir.
  }
}
