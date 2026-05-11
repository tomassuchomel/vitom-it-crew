// Stylizovaný symbol nautilu / logaritmické spirály (zlatý řez) – evokuje znak VITOM,
// aniž bychom kopírovali oficiální logo. Používá se v sidebaru a na login obrazovce.
export default function VitomLogo({ size = 36, color = 'currentColor' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="VITOM"
    >
      {/* Vnější obrys – kruh s otevřenou spirálou */}
      <circle cx="50" cy="50" r="45" stroke={color} strokeWidth="3" opacity="0.15" />
      {/* Logaritmická spirála – Fibonacciho křivka aproximovaná Bezierovými oblouky */}
      <path
        d="M 78 50
           A 28 28 0 0 1 50 78
           A 28 28 0 0 1 22 50
           A 17 17 0 0 1 39 33
           A 10.5 10.5 0 0 1 49.5 43.5
           A 6.5 6.5 0 0 1 43 50
           A 4 4 0 0 1 47 54"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
