/** The FREE mark reduced to a 24px monogram for the collapsed project rail; the full logo shows when the rail is open. */
export default function FreeMonogram({ size = 24 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24">
      <rect width="24" height="24" rx="5" fill="var(--color-accent)" />
      <text x="12" y="17" textAnchor="middle" fontFamily="Albert Sans, system-ui, sans-serif" fontWeight="800" fontSize="14" fill="#fff">F</text>
    </svg>
  )
}
