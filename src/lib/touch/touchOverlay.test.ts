import { describe, expect, it } from "vitest";
import type {
	CursorRecordingData,
	CursorRecordingSample,
	TouchContact,
	TouchFrame,
} from "@/native/contracts";
import { getTouchTimeline, hasTouchRecordingData } from "./touchOverlay";

const contact = (id: number, x: number, y: number, extra: Partial<TouchContact> = {}) => ({
	id,
	state: 4,
	x,
	y,
	size: 0.5,
	grams: 30,
	angle: 0,
	major: 9,
	minor: 8,
	...extra,
});

function recording(
	frames: TouchFrame[],
	samples: CursorRecordingSample[] = [{ timeMs: 0, cx: 0.25, cy: 0.75 }],
): CursorRecordingData {
	return {
		version: 2,
		provider: "none",
		samples,
		assets: [],
		touches: {
			version: 1,
			surfaces: [{ widthMM: 160, heightMM: 100 }],
			normPerMM: { x: 0.003, y: 0.005 },
			frames,
		},
	};
}

function framesOver(
	count: number,
	stepMs: number,
	build: (i: number) => TouchContact[],
): TouchFrame[] {
	return Array.from({ length: count }, (_, i) => ({
		timeMs: i * stepMs,
		device: 0,
		contacts: build(i),
	}));
}

describe("touch timeline", () => {
	it("detects touch data", () => {
		expect(hasTouchRecordingData(recording([]))).toBe(false);
		expect(hasTouchRecordingData(recording(framesOver(1, 16, () => [contact(1, 0.5, 0.5)])))).toBe(
			true,
		);
	});

	it("labels a two-finger pinch out", () => {
		const frames = framesOver(20, 16, (i) => [
			contact(1, 0.45 - i * 0.01, 0.5),
			contact(2, 0.55 + i * 0.01, 0.5),
		]);
		const timeline = getTouchTimeline(recording(frames));
		expect(timeline?.labels.map((l) => l.text)).toContain("Pinch out");
	});

	it("labels a two-finger scroll with its direction", () => {
		const frames = framesOver(20, 16, (i) => [
			contact(1, 0.45, 0.3 + i * 0.02),
			contact(2, 0.55, 0.3 + i * 0.02),
		]);
		const label = getTouchTimeline(recording(frames))?.labels.find((l) => l.kind === "scroll");
		expect(label?.text).toBe("Scroll ↑");
	});

	it("records a flick when a finger lifts while moving fast", () => {
		const moving = framesOver(6, 16, (i) => [contact(1, 0.2 + i * 0.05, 0.5)]);
		const frames = [...moving, { timeMs: 6 * 16, device: 0, contacts: [] }];
		const timeline = getTouchTimeline(recording(frames));
		expect(timeline?.flicks).toHaveLength(1);
		expect(timeline?.flicks[0].velocity.x).toBeGreaterThan(0);
		expect(timeline?.labels.map((l) => l.text)).toContain("Flick →");
	});

	it("turns cursor clicks and force clicks into pulses and labels", () => {
		const frames: TouchFrame[] = [
			{ timeMs: 0, device: 0, contacts: [contact(1, 0.5, 0.5)] },
			{ timeMs: 100, device: 0, stage: 2, contacts: [contact(1, 0.5, 0.5, { grams: 400 })] },
		];
		const samples: CursorRecordingSample[] = [
			{ timeMs: 0, cx: 0.5, cy: 0.5 },
			{ timeMs: 50, cx: 0.5, cy: 0.5, interactionType: "click" },
		];
		const timeline = getTouchTimeline(recording(frames, samples));
		expect(timeline?.pulses.map((p) => p.strong)).toEqual([false, true]);
		expect(timeline?.labels.map((l) => l.text)).toEqual(["Click", "Force click"]);
	});

	it("anchors each touch session at the cursor position where it began", () => {
		const first = framesOver(3, 16, () => [contact(1, 0.5, 0.5)]);
		const second = framesOver(3, 16, () => [contact(1, 0.3, 0.3)]).map((frame) => ({
			...frame,
			timeMs: frame.timeMs + 1000,
		}));
		const samples: CursorRecordingSample[] = [
			{ timeMs: 0, cx: 0.1, cy: 0.2 },
			{ timeMs: 1000, cx: 0.8, cy: 0.6 },
		];
		const sessions = getTouchTimeline(recording([...first, ...second], samples))?.sessions;
		expect(sessions).toHaveLength(2);
		expect(sessions?.[0].anchor).toEqual({ x: 0.1, y: 0.2 });
		expect(sessions?.[1].anchor).toEqual({ x: 0.8, y: 0.6 });
		expect(sessions?.[1].anchorMM).toEqual({ x: 48, y: 30 });
	});
});
