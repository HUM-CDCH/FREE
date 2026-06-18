// Rounded square with a panel divider — left-side divider for the left
// sidebar, mirrored for the right one (from the FREE design sketch).
function PanelToggleIcon({ side }: { side: 'left' | 'right' }) {
  const dividerX = side === 'left' ? 5.5 : 10.5
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <line x1={dividerX} y1="1.7" x2={dividerX} y2="14.3" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

export default PanelToggleIcon
