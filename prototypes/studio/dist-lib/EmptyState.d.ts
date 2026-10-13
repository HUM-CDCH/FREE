import type { ReactNode } from 'react';
export type EmptyStateProps = {
    /** Optional glyph/icon shown above the title. */
    icon?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    tone?: 'neutral' | 'danger';
    /** Action(s) rendered below the copy, e.g. a Button. */
    children?: ReactNode;
    className?: string;
};
declare function EmptyState({ icon, title, description, tone, children, className }: EmptyStateProps): import("react").JSX.Element;
export default EmptyState;
