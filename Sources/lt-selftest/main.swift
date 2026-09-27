// Unit tests for LTKit, run with `swift run lt-selftest` (no amp needed).
// They live in an executable because XCTest/swift-testing are unavailable with the
// Command Line Tools on this machine.
import Foundation
import LTKit

var failures = 0
var passed = 0

func check(_ condition: @autoclosure () -> Bool, _ message: String, file: String = #fileID, line: Int = #line) {
    if condition() {
        passed += 1
    } else {
        failures += 1
        print("FAIL \(file):\(line): \(message)")
    }
}

func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined(separator: " ") }
func bytes(_ hexString: String) -> Data { Data(hexString.split(separator: " ").map { UInt8($0, radix: 16)! }) }
func near(_ a: Double?, _ b: Double, _ tolerance: Double = 1e-4) -> Bool { a.map { abs($0 - b) < tolerance } ?? false }

// MARK: Requests, byte-exact against messages the Mustang LT25 answered during testing.

check(hex(AmpRequest.heartbeat.encoded()) == "08 00 ca 0c 02 08 01", "heartbeat encoding")
check(hex(AmpRequest.connectionStatus.encoded()) == "08 00 d2 0c 02 08 01", "connection status encoding")
check(hex(AmpRequest.firmwareVersion.encoded()) == "08 00 b2 06 02 08 01", "firmware request encoding")
check(hex(AmpRequest.modalStatus(.syncBegin, .ok).encoded()) == "08 00 8a 07 04 08 00 10 00", "SYNC_BEGIN encoding")
check(hex(AmpRequest.retrievePreset(slot: 35).encoded()) == "08 00 ca 06 02 08 23", "retrieve preset encoding")
check(hex(AmpRequest.loadPreset(slot: 1).encoded()) == "08 00 8a 02 02 08 01", "load preset encoding")

let save = AmpRequest.savePresetAs(json: "{}", slot: 49, load: false).encoded()
if let fields = try? ProtoFields(save), let body = fields.message(55) {
    check(body.string(1) == "{}" && body.bool(2) == false && body.int(3) == 49, "savePresetAs fields")
} else {
    check(false, "savePresetAs decodes")
}

// MARK: Protobuf

var writer = ProtoWriter()
writer.int32(1, -2)
writer.float(2, 1.5)
writer.string(3, "é")
let parsed = try! ProtoFields(writer.data)
check(parsed.int(1) == -2, "negative int32 round-trips")
check(parsed.float(2) == 1.5, "float round-trips")
check(parsed.string(3) == "é", "UTF-8 string round-trips")
check((try? ProtoFields(Data([0x0a, 0x05, 0x01]))) == nil, "truncated message is rejected")

// MARK: Responses

check(try! AmpMessage.decode(bytes("08 02 da 0c 02 08 00")) == .connectionStatus(false), "connection status reply")
var reply = ProtoWriter()
reply.int32(1, 2)
reply.message(31) { $0.string(1, "{\"a\":1}"); $0.int32(2, 7) }
check(try! AmpMessage.decode(reply.data) == .presetJSON(json: "{\"a\":1}", slot: 7), "preset JSON reply")
var qa = ProtoWriter()
qa.message(109) { $0.bytes(1, Data([3, 12])) }
check(try! AmpMessage.decode(qa.data) == .qaSlots([3, 12]), "packed repeated QA slots")

// MARK: Framing

let payload = Data((0..<150).map { UInt8($0 % 251) })
let reports = Framing.reports(for: payload)
check(reports.count == 3, "150 bytes → 3 reports")
check(reports.allSatisfy { $0.count == 64 }, "reports are 64 bytes")
check(reports.map { $0[0] } == [0x33, 0x34, 0x35], "chunk tags first/middle/last")
check(reports.map { $0[1] } == [61, 61, 28], "chunk lengths")
check(Framing.reports(for: Data([1, 2]))[0].prefix(4) == Data([0x35, 2, 1, 2]), "single chunk uses last tag")

var reassembler = Framing.Reassembler()
var result: Data?
for report in reports { result = reassembler.feed(Data([0]) + report) } // amp prefixes input reports with 0x00
check(result == payload, "reassembly with leading zero byte")
var fresh = Framing.Reassembler()
check(fresh.feed(reports[1]) == nil, "orphan continuation ignored")
check(fresh.feed(reports[0]) == nil && fresh.feed(reports[1]) == nil && fresh.feed(reports[2]) == payload, "reassembly without prefix")

// MARK: Tapers

check(near(Taper(name: "t10").calc(0.5), 0.1), "t10 is 10% at half travel")
check(near(Taper(name: "t10r").calc(0.5), 0.9, 1e-3), "t10r is 90% at half travel")
check(Taper(name: "t50") == .linear, "t50 is linear")
for name in ["t10", "t10i", "t10r", "t10ri", "t15", "t20r", "t20ri", "t30", "t30i", "t30s", "t20rs", "t45rsi"] {
    let taper = Taper(name: name)
    for x in stride(from: 0.0, through: 1.0, by: 0.125) {
        check(near(taper.invert(taper.calc(x)), x, 1e-6), "\(name) invert∘calc at \(x)")
    }
}

// MARK: Preset names and JSON

check(Preset.displayName(fromAmpName: "JAZZ       AMP  ") == "Jazz Amp", "name fields")
check(Preset.displayName(fromAmpName: "KEEP UR SELF ALI") == "Keep Ur Self Ali", "full-width name")
check(PresetJSON.minified("{ \"a b\" : [1, 2],\n \"c\": \"x \\\" y\" }") == "{\"a b\":[1,2],\"c\":\"x \\\" y\"}", "minifier keeps string contents")

let emptyPreset = """
{"nodeType":"preset","info":{"displayName":"EMPTY           ","product_id":"mustang-lt"},"audioGraph":{"nodes":[
{"nodeId":"stomp","FenderId":"DUBS_Passthru","dspUnitParameters":{"bypass":false}},
{"nodeId":"mod","FenderId":"DUBS_Passthru","dspUnitParameters":{}},
{"nodeId":"amp","FenderId":"DUBS_Twin65","dspUnitParameters":{"volume":-4.497767,"bright":true,"cabsimType":"65twn"}},
{"nodeId":"delay","FenderId":"DUBS_Passthru","dspUnitParameters":{}},
{"nodeId":"reverb","FenderId":"DUBS_Passthru","dspUnitParameters":{}}],"connections":[]}}
"""
let preset = try! Preset(json: emptyPreset, slot: 49)
check(preset.isEmptySlot, "EMPTY name detected")
check(preset.node(.amp)?.params["bright"] == .bool(true), "JSON booleans stay booleans")
check(preset.node(.amp)?.params["volume"] == .number(-4.497767), "numbers parse")
check(preset.validate(catalog: nil).isEmpty, "valid preset passes")
check((try? Preset(json: "{\"nodeType\":\"dspUnit\"}", slot: nil)) == nil, "non-preset JSON rejected")
let missingNode = emptyPreset.replacingOccurrences(of: "\"nodeId\":\"reverb\"", with: "\"nodeId\":\"other\"")
check(!(try! Preset(json: missingNode, slot: nil)).validate(catalog: nil).isEmpty, "missing chain node rejected")

// MARK: Catalog (only when build/catalog.json has been extracted)

let catalogURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../build/catalog.json")
if let data = try? Data(contentsOf: catalogURL), let catalog = try? Catalog(data: data) {
    check(catalog.options[.amp]?.count == 20, "20 amp models")
    check(catalog.options[.stomp]?.first?.fenderId == "DUBS_Passthru", "stomp slot can be empty")
    check(catalog.factoryPresets.count == 100, "100 factory presets")
    if let volume = catalog.unit("DUBS_Twin65")?.param("volume") {
        check(volume.displayString(for: .number(-4.497767)) == "8.0", "Twin volume -4.5 dB shows as 8.0")
        check(near(volume.rawValue(display: 1), -60), "volume 1 = -60 dB")
        check(near(volume.rawValue(display: 10), 0), "volume 10 = 0 dB")
        if let raw = volume.rawValue(display: 6.5) {
            check(near(volume.displayValue(raw: raw), 6.5, 1e-9), "volume display↔raw round trip")
        }
    } else {
        check(false, "Twin65 volume parameter present")
    }
    let time = catalog.unit("DUBS_MonoDelay")?.param("time")
    check(time?.displayString(for: .number(0.4)) == "400 ms", "delay time shows in ms")
    let cabinet = catalog.unit("DUBS_Twin65")?.param("cabsimType")
    check(cabinet?.onLTPanel == false && cabinet?.displayString(for: .string("65twn")) == "'65 Twin", "cabinet from advanced definition")
    let wrongSlot = emptyPreset.replacingOccurrences(of: "\"nodeId\":\"stomp\",\"FenderId\":\"DUBS_Passthru\"",
                                                     with: "\"nodeId\":\"stomp\",\"FenderId\":\"DUBS_Twin65\"")
    check(!(try! Preset(json: wrongSlot, slot: nil)).validate(catalog: catalog).isEmpty, "amp in stomp slot rejected")
    let markdown = MarkdownExporter(catalog: catalog, ampPresets: [preset], info: nil).render()
    check(markdown.contains("`DUBS_Twin65`") && markdown.contains("## Knob values"), "markdown has unit reference")
} else {
    print("note: build/catalog.json not found; catalog tests skipped (run scripts/build-app.sh)")
}

print("\(passed) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
