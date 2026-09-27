import Foundation

/// Fender's parameter tapers (`StandardTaper` in Tone LT Desktop).
///
/// `tNN` is an audio (exponential) curve that reaches NN% at half travel; `i` inverts it,
/// `r` reverses it, `s` makes it an S-curve. `t50` is linear.
public enum Taper: Equatable, Sendable {
    case linear
    case exponential(Double)
    case logarithmic(Double)
    case sCurveExponential(Double)
    case sCurveLogarithmic(Double)

    /// `(tNN constant, tNNr constant)` from the `taperData` table.
    private static let constants: [String: (Double, Double)] = [
        "t10": (81.0, 1013.98999),
        "t15": (32.111, 94.7249985),
        "t20": (16.0, 26.6100006),
        "t25": (9.0, 11.4444999),
        "t30": (5.44444990, 6.05614996),
        "t35": (3.44899011, 3.59179997),
        "t40": (2.25, 2.27540994),
        "t45": (1.49382997, 1.49584997),
    ]

    public init(name: String?) {
        guard let name, name != "t50", name.count >= 3 else {
            self = .linear
            return
        }
        let base = String(name.prefix(3))
        let suffix = name.dropFirst(3)
        guard let (a, b) = Self.constants[base] else {
            self = .linear
            return
        }
        switch suffix {
        case "": self = .exponential(a)
        case "s": self = .sCurveExponential(a)
        case "i": self = .logarithmic(a)
        case "si": self = .sCurveLogarithmic(a)
        case "r": self = .logarithmic(b)
        case "rs": self = .sCurveLogarithmic(b)
        case "ri": self = .exponential(b)
        case "rsi": self = .sCurveExponential(b)
        default: self = .linear
        }
    }

    private static func exp(_ k: Double, _ x: Double) -> Double { (pow(k, x) - 1) / (k - 1) }
    private static func log(_ k: Double, _ x: Double) -> Double { Foundation.log(x * (k - 1) + 1) / Foundation.log(k) }

    /// Maps a normalized position (0…1) through the curve.
    public func calc(_ x: Double) -> Double {
        switch self {
        case .linear: x
        case .exponential(let k): Self.exp(k, x)
        case .logarithmic(let k): Self.log(k, x)
        case .sCurveExponential(let k):
            x < 0.5 ? 0.5 * (1 - Self.exp(k, 1 - 2 * x)) : 0.5 * (Self.exp(k, 2 * x - 1) + 1)
        case .sCurveLogarithmic(let k):
            x < 0.5 ? 0.5 * (1 - Self.log(k, 1 - 2 * x)) : 0.5 * (Self.log(k, 2 * x - 1) + 1)
        }
    }

    /// Inverse of `calc`.
    public func invert(_ y: Double) -> Double {
        switch self {
        case .linear: y
        case .exponential(let k): Self.log(k, y)
        case .logarithmic(let k): Self.exp(k, y)
        case .sCurveExponential(let k):
            y < 0.5 ? (1 - Self.log(k, 1 - 2 * y)) / 2 : (Self.log(k, 2 * y - 1) + 1) / 2
        case .sCurveLogarithmic(let k):
            y < 0.5 ? (1 - Self.exp(k, 1 - 2 * y)) / 2 : (Self.exp(k, 2 * y - 1) + 1) / 2
        }
    }
}
