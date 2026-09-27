import Foundation

/// Minimal protobuf (proto2) wire-format writer, just enough for FenderMessageLT.
public struct ProtoWriter {
    public private(set) var data = Data()

    public init() {}

    mutating func varint(_ value: UInt64) {
        var v = value
        while v >= 0x80 {
            data.append(UInt8(v & 0x7F) | 0x80)
            v >>= 7
        }
        data.append(UInt8(v))
    }

    mutating func key(_ field: Int, _ wireType: Int) {
        varint(UInt64(field << 3 | wireType))
    }

    public mutating func int32(_ field: Int, _ value: Int32) {
        key(field, 0)
        // Negative int32 values are sign-extended to 64 bits on the wire.
        varint(UInt64(bitPattern: Int64(value)))
    }

    public mutating func uint32(_ field: Int, _ value: UInt32) {
        key(field, 0)
        varint(UInt64(value))
    }

    public mutating func bool(_ field: Int, _ value: Bool) {
        key(field, 0)
        varint(value ? 1 : 0)
    }

    public mutating func float(_ field: Int, _ value: Float) {
        key(field, 5)
        withUnsafeBytes(of: value.bitPattern.littleEndian) { data.append(contentsOf: $0) }
    }

    public mutating func bytes(_ field: Int, _ value: Data) {
        key(field, 2)
        varint(UInt64(value.count))
        data.append(value)
    }

    public mutating func string(_ field: Int, _ value: String) {
        bytes(field, Data(value.utf8))
    }

    public mutating func message(_ field: Int, _ build: (inout ProtoWriter) -> Void) {
        var inner = ProtoWriter()
        build(&inner)
        bytes(field, inner.data)
    }
}

public enum ProtoError: Error, Equatable {
    case truncated
    case unsupportedWireType(Int)
}

/// A decoded protobuf field. Only the wire types the Fender protocol uses are supported.
public enum ProtoValue: Equatable {
    case varint(UInt64)
    case fixed64(UInt64)
    case lengthDelimited(Data)
    case fixed32(UInt32)
}

public struct ProtoFields {
    public private(set) var entries: [(field: Int, value: ProtoValue)] = []

    public init(_ data: Data) throws {
        let bytes = [UInt8](data)
        var i = 0

        func readVarint() throws -> UInt64 {
            var result: UInt64 = 0
            var shift: UInt64 = 0
            while true {
                guard i < bytes.count, shift < 64 else { throw ProtoError.truncated }
                let b = bytes[i]
                i += 1
                result |= UInt64(b & 0x7F) << shift
                if b & 0x80 == 0 { return result }
                shift += 7
            }
        }

        func take(_ n: Int) throws -> [UInt8] {
            guard n >= 0, i + n <= bytes.count else { throw ProtoError.truncated }
            defer { i += n }
            return Array(bytes[i..<i + n])
        }

        while i < bytes.count {
            let key = try readVarint()
            let field = Int(key >> 3)
            switch Int(key & 7) {
            case 0:
                entries.append((field, .varint(try readVarint())))
            case 1:
                let b = try take(8)
                let v = b.enumerated().reduce(UInt64(0)) { $0 | UInt64($1.element) << (8 * UInt64($1.offset)) }
                entries.append((field, .fixed64(v)))
            case 2:
                let len = Int(try readVarint())
                entries.append((field, .lengthDelimited(Data(try take(len)))))
            case 5:
                let b = try take(4)
                let v = b.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
                entries.append((field, .fixed32(v)))
            case let wt:
                throw ProtoError.unsupportedWireType(wt)
            }
        }
    }

    public func first(_ field: Int) -> ProtoValue? {
        entries.first { $0.field == field }?.value
    }

    public func all(_ field: Int) -> [ProtoValue] {
        entries.filter { $0.field == field }.map(\.value)
    }

    public func int(_ field: Int) -> Int? {
        guard case .varint(let v)? = first(field) else { return nil }
        return Int(Int32(truncatingIfNeeded: Int64(bitPattern: v)))
    }

    public func bool(_ field: Int) -> Bool? {
        guard case .varint(let v)? = first(field) else { return nil }
        return v != 0
    }

    public func float(_ field: Int) -> Float? {
        guard case .fixed32(let v)? = first(field) else { return nil }
        return Float(bitPattern: v)
    }

    public func data(_ field: Int) -> Data? {
        guard case .lengthDelimited(let d)? = first(field) else { return nil }
        return d
    }

    public func string(_ field: Int) -> String? {
        data(field).map { String(decoding: $0, as: UTF8.self) }
    }

    public func message(_ field: Int) -> ProtoFields? {
        data(field).flatMap { try? ProtoFields($0) }
    }

    /// Repeated varint fields, accepting both packed and unpacked encodings.
    public func repeatedVarints(_ field: Int) -> [UInt64] {
        var out: [UInt64] = []
        for value in all(field) {
            switch value {
            case .varint(let v):
                out.append(v)
            case .lengthDelimited(let d):
                var bytes = [UInt8](d)[...]
                while !bytes.isEmpty {
                    var result: UInt64 = 0
                    var shift: UInt64 = 0
                    while let b = bytes.popFirst() {
                        result |= UInt64(b & 0x7F) << shift
                        if b & 0x80 == 0 { break }
                        shift += 7
                    }
                    out.append(result)
                }
            default:
                continue
            }
        }
        return out
    }
}
