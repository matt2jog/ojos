/** "ojos" wordmark: the o's are eyes, the j is a Google-colored nose with a Gemini spark for its dot. */
export function Logo(): React.JSX.Element {
  return (
    <svg className="logo" viewBox="0 0 74 30" role="img" aria-label="ojos">
      <defs>
        <linearGradient id="ojos-logo-nose" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4285f4" />
          <stop offset="0.35" stopColor="#34a853" />
          <stop offset="0.7" stopColor="#fbbc05" />
          <stop offset="1" stopColor="#ea4335" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round">
        <circle cx={10} cy={18} r={7.5} />
        <circle cx={44} cy={18} r={7.5} />
      </g>
      <g fill="currentColor">
        <circle cx={11.5} cy={18} r={3} />
        <circle cx={45.5} cy={18} r={3} />
      </g>
      <path
        d="M 27 12.5 C 27.4 18 27.8 22.5 26.6 25.6 C 25.7 28 23.4 28.8 21.8 27.6"
        fill="none"
        stroke="url(#ojos-logo-nose)"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <circle cx={22.4} cy={27.4} r={2.6} fill="#ea4335" />
      <path
        d="M 27 1.5 C 27.4 4.4 28.1 5.1 31 5.5 C 28.1 5.9 27.4 6.6 27 9.5 C 26.6 6.6 25.9 5.9 23 5.5 C 25.9 5.1 26.6 4.4 27 1.5 Z"
        fill="currentColor"
      />
      <text x={57} y={25.5} fill="currentColor" fontSize={22} fontWeight={600} fontFamily="'Google Sans', system-ui, sans-serif">
        s
      </text>
    </svg>
  )
}
