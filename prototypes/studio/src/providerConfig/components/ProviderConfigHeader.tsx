import { Pill } from "../../ui";
import { STATUS_TONE, type StatusKind } from "../providerConfig.logic";
import StatusDot from "./StatusDot";

type ProviderConfigHeaderProps = {
	status: StatusKind;
	text: string;
};

function ProviderConfigHeader({ status, text }: ProviderConfigHeaderProps) {
	const tone = STATUS_TONE[status];
	return (
		<header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.75">
			<div className="flex items-center gap-2">
				<span className="text-[13px] font-extrabold tracking-[0.08em] text-accent">
					FREE
				</span>
				<span className="text-[11px] font-medium text-ink-faint">
					/ Providers
				</span>
			</div>
			<Pill tone={tone.pill} outline className="gap-1.5">
				<StatusDot kind={status} />
				{text}
			</Pill>
		</header>
	);
}

export default ProviderConfigHeader;
