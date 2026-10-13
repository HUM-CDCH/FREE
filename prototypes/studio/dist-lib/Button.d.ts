import type { ButtonHTMLAttributes } from 'react';
type Variant = 'primary' | 'secondary' | 'pill';
type Size = 'sm' | 'md';
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    /** Visual weight: terracotta `primary`, outline `secondary`, or rounded `pill`. */
    variant?: Variant;
    size?: Size;
};
declare function Button({ variant, size, className, type, ...props }: ButtonProps): import("react").JSX.Element;
export default Button;
