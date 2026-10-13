import type { ElementType, ReactNode } from 'react';
export type OverlineProps = {
    as?: ElementType;
    children: ReactNode;
    className?: string;
};
/** Uppercase, letter-spaced section label (panel headers). */
declare function Overline({ as: Tag, children, className }: OverlineProps): import("react").JSX.Element;
export default Overline;
