import { useState } from "react";

/** Nota de 1 a 5, acessível por teclado (grupo de botões de opção). */
export function StarRating({ value, onChange, disabled }: { value: number | null; onChange: (n: number) => void; disabled?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <div className="stars" role="radiogroup" aria-label="Nota de 1 a 5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} ${n === 1 ? "estrela" : "estrelas"}`}
          disabled={disabled}
          className={n <= shown ? "star on" : "star"}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(null)}
          onClick={() => onChange(n)}
        >
          ★
        </button>
      ))}
    </div>
  );
}
