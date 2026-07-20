import { STATUS_TONE, type StatusKind } from "../providerConfig.logic";

type StatusDotProps = {
	kind: StatusKind;
};

function StatusDot({ kind }: StatusDotProps) {
	return (
		<span
			aria-hidden="true"
			className={`size-1.25 shrink-0 rounded-full ${STATUS_TONE[kind].dot}`}
		/>
	);
}

export default StatusDot;
