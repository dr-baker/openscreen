import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useScopedT } from "@/contexts/I18nContext";
import {
	TOUCH_LABEL_KINDS,
	type TouchOverlayCorner,
	type TouchOverlaySettings,
	type TouchOverlayStyle,
} from "@/lib/touch/touchOverlay";
import { cn } from "@/lib/utils";

interface TouchSettingsSectionProps {
	settings: TouchOverlaySettings;
	onChange: (settings: TouchOverlaySettings) => void;
}

const STYLES: TouchOverlayStyle[] = ["fingers", "trackpad"];
const CORNERS: TouchOverlayCorner[] = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-center",
	"bottom-right",
];
const SWITCH_CLASS = "data-[state=checked]:bg-[#34B27B] scale-90";

function ChipButton({
	selected,
	onClick,
	children,
}: {
	selected: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			onClick={onClick}
			className={cn(
				"h-6 px-2 rounded-md border text-[10px] font-medium transition-all duration-150",
				selected
					? "border-[#34B27B] bg-[#34B27B]/15 text-slate-100"
					: "border-white/10 bg-white/5 text-slate-400 hover:border-[#34B27B]/40 hover:text-slate-200",
			)}
		>
			{children}
		</button>
	);
}

export function TouchSettingsSection({ settings, onChange }: TouchSettingsSectionProps) {
	const t = useScopedT("settings");
	const update = (patch: Partial<TouchOverlaySettings>) => onChange({ ...settings, ...patch });
	const toggleRow = (key: "pressure" | "pulses" | "flicks", label: string) => (
		<div className="flex items-center justify-between">
			<div className="text-[10px] font-medium text-slate-300">{label}</div>
			<Switch
				checked={settings[key]}
				onCheckedChange={(checked) => update({ [key]: checked })}
				className={SWITCH_CLASS}
				aria-label={label}
			/>
		</div>
	);

	return (
		<div className="p-2 rounded-lg editor-control-surface mt-2 space-y-3">
			<div className="flex items-center justify-between">
				<div className="text-[10px] font-medium text-slate-300">{t("touches.show")}</div>
				<Switch
					checked={settings.show}
					onCheckedChange={(show) => update({ show })}
					className={SWITCH_CLASS}
					aria-label={t("touches.show")}
				/>
			</div>
			{settings.show && (
				<>
					<div className="space-y-1.5">
						<div className="text-[10px] font-medium text-slate-300">{t("touches.style")}</div>
						<div className="flex flex-wrap gap-1.5">
							{STYLES.map((style) => (
								<ChipButton
									key={style}
									selected={settings.style === style}
									onClick={() => update({ style })}
								>
									{t(`touches.styles.${style}`)}
								</ChipButton>
							))}
						</div>
					</div>
					{settings.style === "trackpad" && (
						<div className="space-y-1.5">
							<div className="text-[10px] font-medium text-slate-300">{t("touches.position")}</div>
							<div className="flex flex-wrap gap-1.5">
								{CORNERS.map((corner) => (
									<ChipButton
										key={corner}
										selected={settings.corner === corner}
										onClick={() => update({ corner })}
									>
										{t(`touches.corners.${corner}`)}
									</ChipButton>
								))}
							</div>
						</div>
					)}
					<div className="p-2 rounded-lg bg-white/5 border border-white/5">
						<div className="flex items-center justify-between mb-1">
							<div className="text-[10px] font-medium text-slate-300">{t("touches.size")}</div>
							<span className="text-[10px] text-slate-500 font-mono">
								{settings.size.toFixed(1)}×
							</span>
						</div>
						<Slider
							value={[settings.size]}
							onValueChange={(values) => update({ size: values[0] })}
							min={0.5}
							max={2}
							step={0.1}
							className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
						/>
					</div>
					{toggleRow("pressure", t("touches.pressure"))}
					{toggleRow("pulses", t("touches.pulses"))}
					{toggleRow("flicks", t("touches.flicks"))}
					<div className="space-y-1.5">
						<div className="text-[10px] font-medium text-slate-300">{t("touches.labels")}</div>
						<div className="flex flex-wrap gap-1.5">
							{TOUCH_LABEL_KINDS.map((kind) => (
								<ChipButton
									key={kind}
									selected={settings.labels[kind]}
									onClick={() =>
										update({ labels: { ...settings.labels, [kind]: !settings.labels[kind] } })
									}
								>
									{t(`touches.labelKinds.${kind}`)}
								</ChipButton>
							))}
						</div>
					</div>
				</>
			)}
		</div>
	);
}
