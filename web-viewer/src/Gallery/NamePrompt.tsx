import { useState } from "react";
import { m } from "motion/react";
import "./Gallery.css";

interface NamePromptProps {
  onSubmit: (name: string) => void;
}

const EASE_IOS: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function NamePrompt({ onSubmit }: NamePromptProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    onSubmit(value.trim() || "Invitado");
  };

  return (
    <m.div
      className="gallery-modal-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: EASE_IOS }}
      // Por encima de TODO, visor incluido. Con el 500 de antes quedaba
      // debajo del `.viewer-hero` (z-index 1000): entrando por link directo a
      // un dibujo —que es como llega cualquiera al que le pasan el link— el
      // modal se dibujaba detras del lienzo, no se podia leer ni clickear, y
      // como es bloqueante dejaba la app inutilizable hasta recargar desde la
      // galeria. Va tambien por encima de la vista de foto a pantalla completa
      // (10000) y de sus controles flotantes (10002).
      style={{ zIndex: 20000 }}
    >
      <m.div
        className="gallery-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="titulo-modal-nombre"
        initial={{ opacity: 0, scale: 0.92, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 26 }}
      >
        <h3 id="titulo-modal-nombre">Como te llamas?</h3>
        <p>Se usa para identificar tus dibujos y tus descargas.</p>
        <input
          type="text"
          className="gallery-name-input"
          placeholder="Tu nombre"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button className="gallery-toolbar-btn primary gallery-name-submit" onClick={submit}>
          Continuar
        </button>
        <button className="gallery-modal-cancel" onClick={() => onSubmit("Invitado")}>
          Continuar sin nombre
        </button>
      </m.div>
    </m.div>
  );
}

export default NamePrompt;
