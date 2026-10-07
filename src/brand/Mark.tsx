export function Mark(props: { size?: number }) {
  const size = () => props.size ?? 22;
  const id = `celer-ember-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <svg width={size()} height={size()} viewBox="0 0 128 128" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="24" y1="20" x2="108" y2="112" gradientUnits="userSpaceOnUse">
          <stop style={{ "stop-color": "var(--ember-400)" }} />
          <stop offset="1" style={{ "stop-color": "var(--ember-600)" }} />
        </linearGradient>
      </defs>
      <path d={`M89.5 38.5A36 36 0 1 0 89.5 89.5`} stroke={`url(#${id})`} stroke-width="16" stroke-linecap="round" />
      <rect x="54" y="49" width="50" height="7" rx="3.5" fill="currentColor" />
      <rect x="46" y="60.5" width="72" height="7" rx="3.5" fill="currentColor" />
      <rect x="54" y="72" width="50" height="7" rx="3.5" fill="currentColor" />
    </svg>
  );
}
