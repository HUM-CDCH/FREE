import type { ReactNode } from "react";

type FormFieldProps = {
	label: string;
	children: ReactNode;
};

function FormField({ label, children }: FormFieldProps) {
	return (
		<label className="flex flex-col gap-1.5">
			<span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-muted">
				{label}
			</span>
			{children}
		</label>
	);
}

export default FormField;
