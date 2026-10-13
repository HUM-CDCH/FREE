import type { ReactNode } from 'react';
export type PanelProps = {
    header?: ReactNode;
    footer?: ReactNode;
    children: ReactNode;
    /** Override the body classes (e.g. full-bleed bodies that scroll themselves). */
    bodyClassName?: string;
    className?: string;
};
/** Full-height column with optional bordered header/footer and a scrolling body. */
declare function Panel({ header, footer, children, bodyClassName, className, }: PanelProps): import("react").JSX.Element;
export default Panel;
