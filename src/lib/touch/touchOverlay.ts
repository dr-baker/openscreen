import type {
	CursorRecordingData,
	CursorRecordingSample,
	TouchContact,
	TouchFrame,
	TouchRecordingData,
} from "@/native/contracts";

export type TouchOverlayStyle = "trackpad" | "fingers";
export type TouchOverlayCorner =
	| "bottom-right"
	| "bottom-center"
	| "bottom-left"
	| "top-right"
	| "top-left";
export type TouchLabelKind = "click" | "scroll" | "swipe" | "pinch" | "rotate" | "flick";

export const TOUCH_LABEL_KINDS: TouchLabelKind[] = [
	"click",
	"scroll",
	"swipe",
	"pinch",
	"rotate",
	"flick",
];

export interface TouchOverlaySettings {
	show: boolean;
	style: TouchOverlayStyle;
	corner: TouchOverlayCorner;
	size: number;
	pressure: boolean;
	pulses: boolean;
	flicks: boolean;
	labels: Record<TouchLabelKind, boolean>;
}

export const DEFAULT_TOUCH_OVERLAY_SETTINGS: TouchOverlaySettings = {
	show: true,
	style: "fingers",
	corner: "bottom-right",
	size: 1,
	pressure: true,
	pulses: true,
	flicks: true,
	labels: { click: true, scroll: true, swipe: true, pinch: true, rotate: true, flick: true },
};

const SETTINGS_KEY = "openscreen_touch_overlay";
const STYLES: TouchOverlayStyle[] = ["trackpad", "fingers"];
const CORNERS: TouchOverlayCorner[] = [
	"bottom-right",
	"bottom-center",
	"bottom-left",
	"top-right",
	"top-left",
];

export function loadTouchOverlaySettings(): TouchOverlaySettings {
	const defaults = DEFAULT_TOUCH_OVERLAY_SETTINGS;
	try {
		const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
		if (!raw || typeof raw !== "object") return { ...defaults, labels: { ...defaults.labels } };
		const bool = (value: unknown, fallback: boolean) =>
			typeof value === "boolean" ? value : fallback;
		const labels = { ...defaults.labels };
		for (const kind of TOUCH_LABEL_KINDS) {
			labels[kind] = bool(raw.labels?.[kind], defaults.labels[kind]);
		}
		return {
			show: bool(raw.show, defaults.show),
			style: STYLES.includes(raw.style) ? raw.style : defaults.style,
			corner: CORNERS.includes(raw.corner) ? raw.corner : defaults.corner,
			size:
				typeof raw.size === "number" && Number.isFinite(raw.size)
					? clamp(raw.size, 0.5, 2)
					: defaults.size,
			pressure: bool(raw.pressure, defaults.pressure),
			pulses: bool(raw.pulses, defaults.pulses),
			flicks: bool(raw.flicks, defaults.flicks),
			labels,
		};
	} catch {
		return { ...defaults, labels: { ...defaults.labels } };
	}
}

export function saveTouchOverlaySettings(settings: TouchOverlaySettings) {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// Persisting is best effort; the editor keeps working with in-memory settings.
	}
}

interface Point {
	x: number;
	y: number;
}

interface TouchSession {
	start: number;
	end: number;
	anchor: Point | null;
	anchorMM: Point;
}

interface TouchLabelSpan {
	start: number;
	end: number;
	text: string;
	kind: TouchLabelKind;
}

interface TouchPulse {
	timeMs: number;
	strong: boolean;
}

interface TouchFlick {
	timeMs: number;
	device: number;
	mm: Point;
	velocity: Point;
	sizeMM: number;
	session: TouchSession | null;
}

export interface TouchTimeline {
	data: TouchRecordingData;
	frames: TouchFrame[];
	activeTimes: number[];
	sessions: TouchSession[];
	labels: TouchLabelSpan[];
	pulses: TouchPulse[];
	flicks: TouchFlick[];
}

/** Maps normalized video coordinates (0-1) to canvas pixels. */
export interface TouchOverlayView {
	width: number;
	height: number;
	origin: Point;
	scale: Point;
}

const FRAME_STALE_MS = 120;
const SESSION_GAP_MS = 150;
const LABEL_LINGER_MS = 600;
const CLICK_LABEL_MS = 700;
const DOUBLE_CLICK_MS = 400;
const PULSE_MS = 450;
const FLICK_MS = 550;
const FLICK_SPEED_MM_S = 140;
const FLICK_HISTORY_MS = 80;
const FADE_OUT_DELAY_MS = 250;
const FADE_OUT_MS = 300;
const FADE_IN_MS = 120;
const FULL_PRESSURE_GRAMS = 350;

const isDown = (contact: TouchContact) => contact.state >= 3 && contact.state <= 5;

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function lastIndexAtOrBefore<T>(items: T[], timeMs: number, getTime: (item: T) => number) {
	let low = 0;
	let high = items.length - 1;
	let result = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (getTime(items[mid]) <= timeMs) {
			result = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return result;
}

function surfaceFor(data: TouchRecordingData, device: number) {
	return data.surfaces[device] ?? data.surfaces[0] ?? { widthMM: 160, heightMM: 100 };
}

function contactMM(data: TouchRecordingData, device: number, contact: TouchContact): Point {
	const surface = surfaceFor(data, device);
	return { x: contact.x * surface.widthMM, y: contact.y * surface.heightMM };
}

function centroid(points: Point[]): Point {
	const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
	return { x: sum.x / points.length, y: sum.y / points.length };
}

function wrapAngle(angle: number) {
	let a = angle;
	while (a > Math.PI) a -= 2 * Math.PI;
	while (a < -Math.PI) a += 2 * Math.PI;
	return a;
}

function arrowFor(v: Point) {
	return Math.abs(v.x) > Math.abs(v.y) ? (v.x > 0 ? "→" : "←") : v.y > 0 ? "↑" : "↓";
}

function cursorPointAt(samples: CursorRecordingSample[], timeMs: number): Point | null {
	const index = lastIndexAtOrBefore(samples, timeMs, (s) => s.timeMs);
	if (index < 0) return samples[0] ? { x: samples[0].cx, y: samples[0].cy } : null;
	const a = samples[index];
	const b = samples[index + 1];
	if (!b || b.timeMs <= a.timeMs) return { x: a.cx, y: a.cy };
	const t = clamp((timeMs - a.timeMs) / (b.timeMs - a.timeMs), 0, 1);
	return { x: a.cx + (b.cx - a.cx) * t, y: a.cy + (b.cy - a.cy) * t };
}

const timelineCache = new WeakMap<CursorRecordingData, TouchTimeline | null>();

export function hasTouchRecordingData(data: CursorRecordingData | null | undefined) {
	return Boolean(data?.touches && data.touches.frames.length > 0);
}

export function getTouchTimeline(data: CursorRecordingData | null | undefined) {
	if (!data?.touches || data.touches.frames.length === 0) return null;
	if (timelineCache.has(data)) return timelineCache.get(data) ?? null;
	const timeline = buildTouchTimeline(data.touches, data.samples);
	timelineCache.set(data, timeline);
	return timeline;
}

function buildTouchTimeline(
	data: TouchRecordingData,
	cursorSamples: CursorRecordingSample[],
): TouchTimeline {
	const frames = data.frames;
	const sessions: TouchSession[] = [];
	const labels: TouchLabelSpan[] = [];
	const pulses: TouchPulse[] = [];
	const flicks: TouchFlick[] = [];
	const activeTimes: number[] = [];

	let session: TouchSession | null = null;
	let lastActive = Number.NEGATIVE_INFINITY;
	let baseline: {
		count: number;
		centroid: Point;
		spread: number;
		angles: Map<number, number>;
	} | null = null;
	let gesture: "pinch" | "rotate" | "swipe" | null = null;
	let span: TouchLabelSpan | null = null;
	let previousStage = 0;
	const history = new Map<number, Array<{ t: number; p: Point }>>();
	let lastDown = new Map<number, { device: number; contact: TouchContact }>();

	const closeSpan = (endMs: number) => {
		if (span) {
			span.end = endMs + LABEL_LINGER_MS;
			labels.push(span);
			span = null;
		}
	};
	const showGesture = (timeMs: number, text: string, kind: TouchLabelKind) => {
		if (span && span.text === text) {
			span.end = timeMs;
			return;
		}
		closeSpan(timeMs);
		span = { start: timeMs, end: timeMs, text, kind };
	};

	for (const frame of frames) {
		const t = frame.timeMs;
		const down = frame.contacts.filter(isDown);
		if (frame.contacts.length > 0) activeTimes.push(t);

		// Sessions anchor the fingers style at the cursor where the gesture began.
		if (frame.contacts.length > 0) {
			if (!session || t - lastActive > SESSION_GAP_MS) {
				if (down.length > 0) {
					session = {
						start: t,
						end: t,
						anchor: cursorPointAt(cursorSamples, t),
						anchorMM: centroid(down.map((c) => contactMM(data, frame.device, c))),
					};
					sessions.push(session);
				}
			}
			if (session) session.end = t;
			lastActive = t;
		}

		// Force Touch stage transitions are the haptic clicks we can observe.
		const stage = frame.stage ?? 0;
		if (stage === 2 && previousStage < 2) {
			pulses.push({ timeMs: t, strong: true });
			labels.push({ start: t, end: t + CLICK_LABEL_MS, text: "Force click", kind: "click" });
		} else if (stage === 1 && previousStage === 2) {
			pulses.push({ timeMs: t, strong: false });
		}
		previousStage = down.length > 0 ? stage : 0;

		// Flicks: a contact that lifts while still moving fast.
		const currentDown = new Map(down.map((c) => [c.id, { device: frame.device, contact: c }]));
		for (const c of down) {
			const points = history.get(c.id) ?? [];
			points.push({ t, p: contactMM(data, frame.device, c) });
			while (points.length > 0 && t - points[0].t > FLICK_HISTORY_MS) points.shift();
			history.set(c.id, points);
		}
		const lifted: TouchFlick[] = [];
		for (const [id, entry] of lastDown) {
			if (currentDown.has(id)) continue;
			const points = history.get(id) ?? [];
			history.delete(id);
			const first = points[0];
			const last = points[points.length - 1];
			if (!first || !last || t - last.t > 60) continue;
			const dt = (last.t - first.t) / 1000;
			if (dt < 0.012) continue;
			const velocity = { x: (last.p.x - first.p.x) / dt, y: (last.p.y - first.p.y) / dt };
			if (Math.hypot(velocity.x, velocity.y) < FLICK_SPEED_MM_S) continue;
			lifted.push({
				timeMs: t,
				device: entry.device,
				mm: last.p,
				velocity,
				sizeMM: Math.max(entry.contact.major, 7),
				session,
			});
		}
		lastDown = currentDown;
		if (lifted.length > 0) {
			flicks.push(...lifted);
			const covered = span !== null || labels.some((l) => l.start <= t && l.end >= t);
			if (!covered) {
				const arrow = arrowFor(lifted[0].velocity);
				labels.push({
					start: t,
					end: t + LABEL_LINGER_MS,
					text: lifted.length > 1 ? `${lifted.length}-finger flick ${arrow}` : `Flick ${arrow}`,
					kind: "flick",
				});
			}
		}

		// Multi-finger gesture classification, mirroring Touchcast.
		const pts = new Map(
			down.map((c) => {
				const mm = contactMM(data, frame.device, c);
				return [c.id, { x: mm.x / 100, y: mm.y / 100 }];
			}),
		);
		if (pts.size < 2) {
			if (baseline) {
				baseline = null;
				gesture = null;
				closeSpan(t);
			}
			continue;
		}
		const values = [...pts.values()];
		const c = centroid(values);
		const spread =
			values.reduce((sum, p) => sum + Math.hypot(p.x - c.x, p.y - c.y), 0) / values.length;
		const angles = new Map([...pts].map(([id, p]) => [id, Math.atan2(p.y - c.y, p.x - c.x)]));
		if (!baseline || baseline.count !== pts.size) {
			baseline = { count: pts.size, centroid: c, spread: Math.max(spread, 0.001), angles };
			gesture = null;
			closeSpan(t);
			continue;
		}
		const move = { x: c.x - baseline.centroid.x, y: c.y - baseline.centroid.y };
		const distance = Math.hypot(move.x, move.y);
		const zoom = Math.log(spread / baseline.spread);
		const shared = [...angles.keys()].filter((id) => baseline?.angles.has(id));
		const rotation =
			shared.length === 0
				? 0
				: shared.reduce(
						(sum, id) => sum + wrapAngle((angles.get(id) ?? 0) - (baseline?.angles.get(id) ?? 0)),
						0,
					) / shared.length;
		const n = pts.size;
		if (!gesture) {
			if (Math.abs(zoom) > (n === 2 ? 0.2 : 0.25) && Math.abs(zoom) * 0.4 > distance)
				gesture = "pinch";
			else if (n === 2 && Math.abs(rotation) > 0.35) gesture = "rotate";
			else if (distance > 0.07) gesture = "swipe";
		}
		if (gesture === "pinch") {
			const dir = zoom > 0 ? "out" : "in";
			showGesture(t, n === 2 ? `Pinch ${dir}` : `${n}-finger pinch ${dir}`, "pinch");
		} else if (gesture === "rotate") {
			showGesture(t, rotation > 0 ? "Rotate ↺" : "Rotate ↻", "rotate");
		} else if (gesture === "swipe") {
			const arrow = arrowFor(move);
			showGesture(
				t,
				n === 2 ? `Scroll ${arrow}` : `${n}-finger swipe ${arrow}`,
				n === 2 ? "scroll" : "swipe",
			);
		}
	}
	const lastFrame = frames[frames.length - 1];
	if (lastFrame) closeSpan(lastFrame.timeMs);

	// Clicks come from the cursor recording, which captures every button press.
	let previousClick = Number.NEGATIVE_INFINITY;
	for (const sample of cursorSamples) {
		if (sample.interactionType === "click") {
			const isDouble = sample.timeMs - previousClick < DOUBLE_CLICK_MS;
			previousClick = sample.timeMs;
			pulses.push({ timeMs: sample.timeMs, strong: false });
			labels.push({
				start: sample.timeMs,
				end: sample.timeMs + CLICK_LABEL_MS,
				text: isDouble ? "Double click" : "Click",
				kind: "click",
			});
		} else if (sample.interactionType === "mouseup") {
			pulses.push({ timeMs: sample.timeMs, strong: false });
		}
	}

	labels.sort((a, b) => a.start - b.start);
	pulses.sort((a, b) => a.timeMs - b.timeMs);
	return { data, frames, activeTimes, sessions, labels, pulses, flicks };
}

function heatColor(pressure: number, alpha = 1) {
	return `hsla(25, ${Math.round(pressure * 85)}%, ${Math.round(100 - pressure * 40)}%, ${alpha})`;
}

function pressureOf(contact: TouchContact, stage: number) {
	if (!isDown(contact)) return 0;
	const finger = Math.sqrt(clamp(contact.grams / FULL_PRESSURE_GRAMS, 0, 1));
	return stage >= 2 ? 1 : finger;
}

function easeOut(t: number) {
	return 1 - (1 - t) ** 3;
}

function activeLabel(timeline: TouchTimeline, timeMs: number, settings: TouchOverlaySettings) {
	let best: TouchLabelSpan | null = null;
	for (const label of timeline.labels) {
		if (label.start > timeMs) break;
		if (label.end >= timeMs && settings.labels[label.kind]) best = label;
	}
	return best;
}

function drawPill(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	u: number,
	alpha: number,
) {
	ctx.save();
	ctx.globalAlpha *= alpha;
	ctx.font = `600 ${15 * u}px ui-rounded, -apple-system, "SF Pro Rounded", system-ui, sans-serif`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const width = ctx.measureText(text).width + 32 * u;
	const height = 34 * u;
	ctx.shadowColor = "rgba(0,0,0,0.3)";
	ctx.shadowBlur = 12 * u;
	ctx.beginPath();
	ctx.roundRect(x - width / 2, y - height / 2, width, height, height / 2);
	ctx.fillStyle = "rgba(22,22,26,0.78)";
	ctx.fill();
	ctx.shadowBlur = 0;
	ctx.strokeStyle = "rgba(255,255,255,0.16)";
	ctx.lineWidth = u;
	ctx.stroke();
	ctx.fillStyle = "#fff";
	ctx.fillText(text, x, y + 0.5 * u);
	ctx.restore();
}

function drawPulseRings(
	timeline: TouchTimeline,
	timeMs: number,
	draw: (progress: number, strong: boolean) => void,
) {
	const start = lastIndexAtOrBefore(timeline.pulses, timeMs, (p) => p.timeMs);
	for (let i = start; i >= 0; i--) {
		const pulse = timeline.pulses[i];
		const age = timeMs - pulse.timeMs;
		const duration = pulse.strong ? PULSE_MS * 1.25 : PULSE_MS;
		if (age > PULSE_MS * 1.25) break;
		if (age <= duration) draw(easeOut(age / duration), pulse.strong);
	}
}

function drawFlickGhosts(
	ctx: CanvasRenderingContext2D,
	timeline: TouchTimeline,
	timeMs: number,
	project: (flick: TouchFlick) => { start: Point; pxPerMM: Point; diameter: number } | null,
) {
	for (const flick of timeline.flicks) {
		const age = timeMs - flick.timeMs;
		if (age < 0 || age > FLICK_MS) continue;
		const projected = project(flick);
		if (!projected) continue;
		const glide = 0.14;
		let travel = { x: flick.velocity.x * glide, y: flick.velocity.y * glide };
		const length = Math.hypot(travel.x, travel.y);
		if (length > 60) travel = { x: (travel.x / length) * 60, y: (travel.y / length) * 60 };
		for (let i = 1; i <= 3; i++) {
			const local = clamp((age - i * 30) / (FLICK_MS - 90), 0, 1);
			const progress = easeOut(local) * (i / 3);
			const x = projected.start.x + travel.x * projected.pxPerMM.x * progress;
			const y = projected.start.y - travel.y * projected.pxPerMM.y * progress;
			const radius = (projected.diameter * (1 - (i / 3) * 0.35)) / 2;
			ctx.save();
			ctx.globalAlpha *= (1 - local) * (0.6 - i * 0.12);
			ctx.beginPath();
			ctx.arc(x, y, radius, 0, Math.PI * 2);
			ctx.fillStyle = "#fff";
			ctx.fill();
			ctx.restore();
		}
	}
}

/** Draws the touch overlay for `timeMs`. Shared by the editor preview and the exporter. */
export function drawTouchOverlay(
	ctx: CanvasRenderingContext2D,
	timeline: TouchTimeline,
	timeMs: number,
	settings: TouchOverlaySettings,
	view: TouchOverlayView,
) {
	if (!settings.show) return;
	const frameIndex = lastIndexAtOrBefore(timeline.frames, timeMs, (f) => f.timeMs);
	const frame = frameIndex >= 0 ? timeline.frames[frameIndex] : null;
	const contacts = frame && timeMs - frame.timeMs <= FRAME_STALE_MS ? frame.contacts : [];
	const stage = frame?.stage ?? 0;
	const label = activeLabel(timeline, timeMs, settings);
	const u = (Math.min(view.width, view.height) / 720) * settings.size;

	if (settings.style === "trackpad") {
		drawTrackpad(ctx, timeline, timeMs, settings, view, u, frame, contacts, stage, label);
	} else {
		drawFingers(ctx, timeline, timeMs, settings, view, u, frame, contacts, stage, label);
	}
}

function drawTrackpad(
	ctx: CanvasRenderingContext2D,
	timeline: TouchTimeline,
	timeMs: number,
	settings: TouchOverlaySettings,
	view: TouchOverlayView,
	u: number,
	frame: TouchFrame | null,
	contacts: TouchContact[],
	stage: number,
	label: TouchLabelSpan | null,
) {
	const lastActiveIndex = lastIndexAtOrBefore(timeline.activeTimes, timeMs, (t) => t);
	const lastActive = lastActiveIndex >= 0 ? timeline.activeTimes[lastActiveIndex] : null;
	const sessionIndex = lastIndexAtOrBefore(timeline.sessions, timeMs, (s) => s.start);
	const session = sessionIndex >= 0 ? timeline.sessions[sessionIndex] : null;
	let alpha =
		lastActive === null
			? 0
			: clamp(1 - (timeMs - lastActive - FADE_OUT_DELAY_MS) / FADE_OUT_MS, 0, 1);
	if (session && timeMs >= session.start && timeMs - session.start < FADE_IN_MS) {
		alpha = Math.min(alpha, (timeMs - session.start) / FADE_IN_MS);
	}
	if (label) alpha = Math.max(alpha, labelAlpha(label, timeMs));
	if (alpha <= 0) return;

	const surface = surfaceFor(timeline.data, frame?.device ?? 0);
	const padWidth = 250 * u;
	const padHeight = padWidth * (surface.heightMM / surface.widthMM);
	const margin = 28 * u;
	const labelSpace = 48 * u;
	const corner = settings.corner;
	const x =
		corner === "bottom-left" || corner === "top-left"
			? margin
			: corner === "bottom-center"
				? (view.width - padWidth) / 2
				: view.width - padWidth - margin;
	const y = corner.startsWith("top") ? margin + labelSpace : view.height - padHeight - margin;
	const radius = 22 * u;

	ctx.save();
	ctx.globalAlpha = alpha;
	ctx.shadowColor = "rgba(0,0,0,0.35)";
	ctx.shadowBlur = 24 * u;
	ctx.shadowOffsetY = 6 * u;
	ctx.beginPath();
	ctx.roundRect(x, y, padWidth, padHeight, radius);
	ctx.fillStyle = "rgba(20,20,24,0.62)";
	ctx.fill();
	ctx.shadowColor = "transparent";
	const sheen = ctx.createLinearGradient(x, y, x, y + padHeight);
	sheen.addColorStop(0, "rgba(255,255,255,0.12)");
	sheen.addColorStop(0.5, "rgba(255,255,255,0.02)");
	sheen.addColorStop(1, "rgba(255,255,255,0.05)");
	ctx.fillStyle = sheen;
	ctx.fill();
	ctx.strokeStyle = "rgba(255,255,255,0.2)";
	ctx.lineWidth = u;
	ctx.stroke();

	if (settings.pulses) {
		drawPulseRings(timeline, timeMs, (progress, strong) => {
			const grow = (strong ? 10 : 6) * u * progress;
			ctx.save();
			ctx.globalAlpha *= 0.8 * (1 - progress);
			ctx.beginPath();
			ctx.roundRect(x - grow, y - grow, padWidth + grow * 2, padHeight + grow * 2, radius + grow);
			ctx.strokeStyle = "#fff";
			ctx.lineWidth = (strong ? 3 : 2) * u;
			ctx.stroke();
			ctx.restore();
		});
	}

	ctx.save();
	ctx.beginPath();
	ctx.roundRect(x, y, padWidth, padHeight, radius);
	ctx.clip();
	for (const contact of contacts) {
		const cx = x + contact.x * padWidth;
		const cy = y + (1 - contact.y) * padHeight;
		const pressure = pressureOf(contact, stage);
		const r = (10 + clamp(contact.size, 0, 1.5) * 6) * u;
		const scale = settings.pressure ? 1 + pressure * 0.55 : 1;
		ctx.save();
		ctx.globalAlpha *= isDown(contact) ? 0.95 : 0.3;
		ctx.shadowColor = heatColor(pressure, isDown(contact) ? 0.8 : 0);
		ctx.shadowBlur = (settings.pressure ? 4 + pressure * 14 : 6) * u;
		const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * scale * 1.2);
		gradient.addColorStop(0, "#fff");
		gradient.addColorStop(1, heatColor(pressure, 0.85));
		ctx.beginPath();
		ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
		ctx.fillStyle = gradient;
		ctx.fill();
		ctx.restore();
		if (isDown(contact) && settings.pressure) {
			const ringR = r + 9 * u;
			ctx.beginPath();
			ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
			ctx.strokeStyle = "rgba(255,255,255,0.18)";
			ctx.lineWidth = 3 * u;
			ctx.stroke();
			if (pressure > 0.01) {
				ctx.beginPath();
				ctx.arc(
					cx,
					cy,
					ringR * (stage >= 2 ? 1.2 : 1),
					-Math.PI / 2,
					-Math.PI / 2 + pressure * Math.PI * 2,
				);
				ctx.strokeStyle = heatColor(pressure);
				ctx.lineCap = "round";
				ctx.stroke();
			}
		}
		if (isDown(contact) && settings.pulses) {
			drawPulseRings(timeline, timeMs, (progress, strong) => {
				ctx.save();
				ctx.globalAlpha *= 0.9 * (1 - progress);
				ctx.beginPath();
				ctx.arc(cx, cy, (r + 3 * u) * (1 + progress * (strong ? 1.5 : 0.9)), 0, Math.PI * 2);
				ctx.strokeStyle = "#fff";
				ctx.lineWidth = (strong ? 3 : 2) * u;
				ctx.stroke();
				ctx.restore();
			});
		}
	}
	if (settings.flicks) {
		drawFlickGhosts(ctx, timeline, timeMs, (flick) => {
			const s = surfaceFor(timeline.data, flick.device);
			const pxPerMM = { x: padWidth / s.widthMM, y: padHeight / s.heightMM };
			return {
				start: { x: x + flick.mm.x * pxPerMM.x, y: y + padHeight - flick.mm.y * pxPerMM.y },
				pxPerMM: { x: pxPerMM.x * 0.6, y: pxPerMM.y * 0.6 },
				diameter: 20 * u,
			};
		});
	}
	ctx.restore();

	if (label) {
		drawPill(ctx, label.text, x + padWidth / 2, y - 26 * u, u, labelAlpha(label, timeMs));
	}
	ctx.restore();
}

function labelAlpha(label: TouchLabelSpan, timeMs: number) {
	return clamp(Math.min((timeMs - label.start) / 120, (label.end - timeMs) / 150), 0, 1);
}

function drawFingers(
	ctx: CanvasRenderingContext2D,
	timeline: TouchTimeline,
	timeMs: number,
	settings: TouchOverlaySettings,
	view: TouchOverlayView,
	u: number,
	frame: TouchFrame | null,
	contacts: TouchContact[],
	stage: number,
	label: TouchLabelSpan | null,
) {
	const { data } = timeline;
	const pxPerMM = { x: data.normPerMM.x * view.scale.x, y: data.normPerMM.y * view.scale.y };
	const toCanvas = (session: TouchSession, mm: Point): Point => {
		const anchor = session.anchor ?? { x: 0.5, y: 0.5 };
		const origin = {
			x: view.origin.x + anchor.x * view.scale.x,
			y: view.origin.y + anchor.y * view.scale.y,
		};
		return {
			x: origin.x + (mm.x - session.anchorMM.x) * pxPerMM.x,
			y: origin.y - (mm.y - session.anchorMM.y) * pxPerMM.y,
		};
	};

	if (settings.flicks) {
		drawFlickGhosts(ctx, timeline, timeMs, (flick) =>
			flick.session
				? {
						start: toCanvas(flick.session, flick.mm),
						pxPerMM,
						diameter: flick.sizeMM * pxPerMM.x,
					}
				: null,
		);
	}

	const sessionIndex = lastIndexAtOrBefore(timeline.sessions, timeMs, (s) => s.start);
	const session = sessionIndex >= 0 ? timeline.sessions[sessionIndex] : null;
	if (!frame || !session || contacts.length === 0 || timeMs > session.end + FRAME_STALE_MS) return;

	const points: Point[] = [];
	for (const contact of contacts) {
		const p = toCanvas(session, contactMM(data, frame.device, contact));
		points.push(p);
		const w = Math.max(contact.major, 7) * pxPerMM.x;
		const h = Math.max(contact.minor, 7) * pxPerMM.x;
		const pressure = pressureOf(contact, stage);
		ctx.save();
		ctx.globalAlpha *= isDown(contact) ? 1 : 0.35;
		ctx.translate(p.x, p.y);
		ctx.rotate(-contact.angle);
		const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) * 0.6);
		gradient.addColorStop(0, "rgba(255,255,255,0.85)");
		gradient.addColorStop(1, heatColor(pressure, 0.55));
		ctx.shadowColor = "rgba(0,0,0,0.35)";
		ctx.shadowBlur = 6 * u;
		ctx.shadowOffsetY = 2 * u;
		ctx.beginPath();
		ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
		ctx.fillStyle = gradient;
		ctx.fill();
		ctx.shadowColor = "transparent";
		ctx.strokeStyle = "rgba(255,255,255,0.9)";
		ctx.lineWidth = 1.5 * u;
		ctx.stroke();
		ctx.restore();

		if (isDown(contact) && settings.pressure && pressure > 0.01) {
			const ringR = Math.max(w, h) / 2 + 7 * u;
			ctx.beginPath();
			ctx.arc(
				p.x,
				p.y,
				ringR * (stage >= 2 ? 1.15 : 1),
				-Math.PI / 2,
				-Math.PI / 2 + pressure * Math.PI * 2,
			);
			ctx.strokeStyle = heatColor(pressure);
			ctx.lineWidth = 3 * u;
			ctx.lineCap = "round";
			ctx.stroke();
		}
		if (isDown(contact) && settings.pulses) {
			drawPulseRings(timeline, timeMs, (progress, strong) => {
				ctx.save();
				ctx.globalAlpha *= 0.9 * (1 - progress);
				ctx.beginPath();
				ctx.arc(
					p.x,
					p.y,
					(Math.max(w, h) / 2) * (1 + progress * (strong ? 1.6 : 1)),
					0,
					Math.PI * 2,
				);
				ctx.strokeStyle = "#fff";
				ctx.lineWidth = (strong ? 3 : 2) * u;
				ctx.stroke();
				ctx.restore();
			});
		}
	}

	if (label && points.length > 0) {
		const midX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
		const maxY = Math.max(...points.map((p) => p.y));
		drawPill(ctx, label.text, midX, maxY + 18 * pxPerMM.y + 10 * u, u, labelAlpha(label, timeMs));
	}
}
