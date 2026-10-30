import AppKit
import Foundation

// Reads raw trackpad contacts from the private MultitouchSupport framework (no permission
// prompt required) and streams them as `touch` events alongside cursor samples.
typealias MTContactCallback = @convention(c) (
	UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, Int32, Double, Int32
) -> Int32

struct TouchSurface {
	let widthMM: Double
	let heightMM: Double
}

final class TouchTracker {
	static let shared = TouchTracker()

	private let fingerStride = 96
	private let minFrameIntervalMs = 16
	private let lock = NSLock()
	private var devices: [AnyObject] = []
	private var deviceIndex: [UnsafeMutableRawPointer: Int] = [:]
	private(set) var surfaces: [TouchSurface] = []
	private var lastEmitMs: [Int: Int] = [:]
	private var lastSignature: [Int: [Int32]] = [:]
	private var forceStage = 0

	func setForceStage(_ stage: Int) {
		lock.lock()
		forceStage = stage
		lock.unlock()
	}

	func start() -> Bool {
		guard let handle = dlopen(
			"/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport",
			RTLD_NOW
		) else {
			return false
		}
		func sym<T>(_ name: String, _ type: T.Type) -> T? {
			dlsym(handle, name).map { unsafeBitCast($0, to: type) }
		}
		guard
			let createList = sym("MTDeviceCreateList", (@convention(c) () -> Unmanaged<CFArray>).self),
			let register = sym(
				"MTRegisterContactFrameCallback",
				(@convention(c) (UnsafeMutableRawPointer, MTContactCallback) -> Void).self
			),
			let startDevice = sym(
				"MTDeviceStart",
				(@convention(c) (UnsafeMutableRawPointer, Int32) -> Void).self
			)
		else {
			return false
		}
		let dimensions = sym(
			"MTDeviceGetSensorSurfaceDimensions",
			(@convention(c) (
				UnsafeMutableRawPointer, UnsafeMutablePointer<Int32>, UnsafeMutablePointer<Int32>
			) -> Int32).self
		)

		devices = createList().takeRetainedValue() as [AnyObject]
		for (index, device) in devices.enumerated() {
			let ref = Unmanaged.passUnretained(device).toOpaque()
			deviceIndex[ref] = index
			var width: Int32 = 0
			var height: Int32 = 0
			if let dimensions, dimensions(ref, &width, &height) == 0, width > 0, height > 0 {
				surfaces.append(TouchSurface(widthMM: Double(width) / 100, heightMM: Double(height) / 100))
			} else {
				surfaces.append(TouchSurface(widthMM: 160, heightMM: 100))
			}
		}
		for device in devices {
			let ref = Unmanaged.passUnretained(device).toOpaque()
			register(ref, touchFrameCallback)
			startDevice(ref, 0)
		}
		return !devices.isEmpty
	}

	fileprivate func handleFrame(device: UnsafeMutableRawPointer?, data: UnsafeMutableRawPointer?, count: Int) {
		let index = device.flatMap { deviceIndex[$0] } ?? 0
		var contacts: [String] = []
		var signature: [Int32] = []
		if let data {
			let base = UnsafeRawPointer(data)
			for i in 0..<count {
				let f = base + i * fingerStride
				let state = f.load(fromByteOffset: 20, as: Int32.self)
				guard (1...6).contains(state) else { continue }
				let id = f.load(fromByteOffset: 16, as: Int32.self)
				signature.append(id * 10 + state)
				let values: [(Int, Int)] = [(32, 4), (36, 4), (48, 3), (52, 1), (56, 3), (60, 2), (64, 2)]
				let fields = values.map { offset, places in
					format(f.load(fromByteOffset: offset, as: Float.self), places)
				}
				contacts.append("[\(id),\(state),\(fields.joined(separator: ","))]")
			}
		}

		let now = timestampMs()
		lock.lock()
		let previousSignature = lastSignature[index] ?? []
		let changed = previousSignature != signature
		let due = now - (lastEmitMs[index] ?? 0) >= minFrameIntervalMs
		let stage = forceStage
		if contacts.isEmpty && previousSignature.isEmpty {
			lock.unlock()
			return
		}
		guard changed || due else {
			lock.unlock()
			return
		}
		lastSignature[index] = signature
		lastEmitMs[index] = now
		lock.unlock()

		// Hand-built JSON keeps high-rate frames compact (JSONSerialization prints full doubles).
		emitLine(
			"{\"type\":\"touch\",\"timestampMs\":\(now),\"device\":\(index),\"stage\":\(stage),\"contacts\":[\(contacts.joined(separator: ","))]}"
		)
	}

	private func format(_ value: Float, _ places: Int) -> String {
		guard value.isFinite else { return "0" }
		var text = String(format: "%.\(places)f", value)
		if text.contains(".") {
			while text.hasSuffix("0") { text.removeLast() }
			if text.hasSuffix(".") { text.removeLast() }
		}
		return text == "-0" ? "0" : text
	}
}

private let touchFrameCallback: MTContactCallback = { device, data, count, _, _ in
	TouchTracker.shared.handleFrame(device: device, data: data, count: Int(count))
	return 0
}

/// Points per millimetre for the display under the cursor, used for true-scale overlays.
func displayPointsPerMM() -> Double? {
	let mouse = NSEvent.mouseLocation
	guard let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main,
		let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
	else {
		return nil
	}
	let size = CGDisplayScreenSize(number.uint32Value)
	guard size.width > 0 else { return nil }
	return Double(screen.frame.width) / Double(size.width)
}
