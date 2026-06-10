export type AnnotationSetItem = {
  id: string
  label: string
  pageNumber: number
}

type AnnotationSidebarProps = {
  items: AnnotationSetItem[]
  onSelectItem: (id: string) => void
  onRemoveItem: (id: string) => void
}

function AnnotationSidebar({ items, onSelectItem, onRemoveItem }: AnnotationSidebarProps) {
  return (
    <aside className="annotation-sidebar" aria-label="Annotation set">
      <header className="annotation-sidebar__header">
        <h2>Annotation Set</h2>
        <span className="annotation-sidebar__count" aria-label={`${items.length} annotations`}>
          {items.length}
        </span>
      </header>

      <section className="annotation-sidebar__group" aria-labelledby="annotation-set-title">
        <h3 id="annotation-set-title">Baggrund og udgravning</h3>
        {items.length === 0 ? (
          <p className="annotation-sidebar__empty">No highlights yet</p>
        ) : (
          <ul className="annotation-sidebar__chips">
            {items.map((item) => (
              <li key={item.id}>
                <span className="annotation-chip">
                  <button
                    className="annotation-chip__label"
                    type="button"
                    title={`Go to highlight on page ${item.pageNumber}: ${item.label}`}
                    onClick={() => onSelectItem(item.id)}
                  >
                    {item.label}
                  </button>
                  <button
                    className="annotation-chip__remove"
                    type="button"
                    aria-label={`Remove highlight: ${item.label}`}
                    title={`Remove highlight: ${item.label}`}
                    onClick={() => onRemoveItem(item.id)}
                  >
                    x
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}

export default AnnotationSidebar
