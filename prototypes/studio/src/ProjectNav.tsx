import { useState } from 'react'
import PanelToggleIcon from './PanelToggleIcon'
import { Overline } from './ui'

export const ACTIVE_DOC = 'Beretning_Ellekilde_8_13.pdf'
export const ACTIVE_PROJECT = 'Ellekilde, TAK 1355'
export const HISTORICAL_TEST_DOC = '1790-06-17-1.pdf'
export const COLLAGEN_TEST_DOC =
  'Zhang et al. 2024 - Properties of skin collagen from southern catfish (Silurus meridionalis) fed with raw and cooked food.pdf'

const PROJECTS = [
  { name: ACTIVE_PROJECT, docs: [ACTIVE_DOC, 'Fundliste_TAK1355.pdf', 'Fotoliste_TAK1355.pdf'] },
  { name: 'Snubbekorsgård, TAK 1402', docs: ['Beretning_Snubbekorsgård.pdf'] },
  { name: 'Vasbygård, TAK 1288', docs: ['Beretning_Vasbygård_grav1_4.pdf'] },
  { name: 'Test documents', docs: [HISTORICAL_TEST_DOC, COLLAGEN_TEST_DOC] },
]

type ProjectNavProps = {
  open: boolean
  onToggle: () => void
  onToast: (message: string) => void
  activeDocument: string
  selectableDocuments: ReadonlySet<string>
  onSelectDocument: (filename: string) => void
}

function ProjectNav({
  open,
  onToggle,
  onToast,
  activeDocument,
  selectableDocuments,
  onSelectDocument,
}: ProjectNavProps) {
  const [openProjects, setOpenProjects] = useState(() =>
    PROJECTS.map((_, index) => index === 0 || index === PROJECTS.length - 1),
  )

  if (!open) {
    return (
      <div className="flex h-full flex-col items-center">
        <button
          className="flex cursor-pointer items-center justify-center py-3 text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
          type="button"
          title="Expand projects"
          onClick={onToggle}
        >
          <PanelToggleIcon side="left" />
        </button>
        <span className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted [writing-mode:vertical-rl]">
          Projects
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between py-3 pl-4 pr-2.5">
        <Overline as="h2">Projects</Overline>
        <button
          className="cursor-pointer px-1 text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
          type="button"
          title="Collapse projects"
          onClick={onToggle}
        >
          <PanelToggleIcon side="left" />
        </button>
      </header>
      <nav className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-label="Projects">
        <ul className="flex flex-col gap-px">
          {PROJECTS.map((project, index) => {
            const projectOpen = openProjects[index]
            return (
              <li key={project.name}>
                <button
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] font-bold text-ink outline-none transition-colors hover:bg-accent-ghost focus-visible:bg-accent-ghost"
                  type="button"
                  aria-expanded={projectOpen}
                  onClick={() =>
                    setOpenProjects((state) => state.map((value, i) => (i === index ? !value : value)))
                  }
                >
                  <span aria-hidden="true" className="shrink-0 text-[10px] text-ink-muted">
                    {projectOpen ? '▾' : '▸'}
                  </span>
                  <span className="min-w-0 truncate">{project.name}</span>
                </button>
                {projectOpen && (
                  <ul className="flex flex-col gap-px">
                    {project.docs.map((doc) => {
                      const active = doc === activeDocument
                      const selectable = selectableDocuments.has(doc)
                      return (
                        <li key={doc}>
                          <button
                            className={`flex w-full cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pl-6 pr-2 text-left text-xs outline-none transition-colors hover:bg-accent-ghost focus-visible:bg-accent-ghost ${
                              active ? 'bg-accent-ghost font-semibold text-ink' : 'font-medium text-ink-muted'
                            }`}
                            type="button"
                            aria-current={active ? 'true' : undefined}
                            disabled={active}
                            onClick={() =>
                              selectable
                                ? onSelectDocument(doc)
                                : onToast(`${doc} is not loaded in this prototype`)
                            }
                          >
                            <span
                              aria-hidden="true"
                              className={`shrink-0 text-[10px] ${active ? 'text-accent' : 'text-ink-muted'}`}
                            >
                              ▢
                            </span>
                            <span className="min-w-0 truncate">{doc}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}

export default ProjectNav
