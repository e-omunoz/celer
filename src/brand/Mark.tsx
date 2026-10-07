let seq = 0;

/** Celer mark: the Ember "C" with data rows leaving through its opening. Bars use the text colour. */
export function Mark(props: { size?: number; class?: string }) {
  const size = () => props.size ?? 22;
  const id = `celer-ember-${++seq}`;
  return (
    <svg class={props.class} width={size()} height={size()} viewBox="150 220 780 584" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="230" y1="250" x2="660" y2="780" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFA15C" />
          <stop offset=".55" stop-color="#F26B2A" />
          <stop offset="1" stop-color="#D9481C" />
        </linearGradient>
      </defs>
      <path d="M625.8 344.7A250 250 0 1 0 625.8 679.3" stroke={`url(#${id})`} stroke-width="118" stroke-linecap="round" />
      <rect x="470" y="406" width="320" height="56" rx="28" fill="currentColor" />
      <rect x="410" y="484" width="490" height="56" rx="28" fill="currentColor" />
      <rect x="470" y="562" width="320" height="56" rx="28" fill="currentColor" />
    </svg>
  );
}
