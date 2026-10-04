// FREE UI — presentational primitives, decoupled from PDF.js and app state.
// The lib build (vite.lib.config.ts) emits the compiled bundle + a styles.css
// carrying the look; design-sync's package shape consumes that dist.
import '../index.css'

export { default as Button } from './Button'
export type { ButtonProps } from './Button'
export { default as DeleteDialog } from './DeleteDialog'
export type { DeleteDialogProps } from './DeleteDialog'
export { default as ModalDialog } from './ModalDialog'
export type { ModalDialogProps } from './ModalDialog'
export { default as Pill } from './Pill'
export type { PillProps } from './Pill'
export { default as SegmentedControl } from './SegmentedControl'
export type { SegmentedControlProps, Segment } from './SegmentedControl'
export { default as EmptyState } from './EmptyState'
export type { EmptyStateProps } from './EmptyState'
export { default as Spinner } from './Spinner'
export type { SpinnerProps } from './Spinner'
export { default as Toast } from './Toast'
export type { ToastAction, ToastProps } from './Toast'
export { default as Overline } from './Overline'
export type { OverlineProps } from './Overline'
export { default as PhaseProgress } from './PhaseProgress'
export type {
  PhaseProgressProps,
  PhaseProgressTone,
  WorkflowPhase,
} from './PhaseProgress'
export { default as Panel } from './Panel'
export type { PanelProps } from './Panel'
export { default as ProgressBar } from './ProgressBar'
export type { ProgressBarProps } from './ProgressBar'
export { CheckIcon, PencilIcon, XIcon, StatusDot, UndoIcon } from './icons'
