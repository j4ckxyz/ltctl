// Draws the ToneLT app icon (a chrome amp knob on a dark tolex square) as a 1024px PNG.
// Usage: swift tools/make_icon.swift out.png
import AppKit

let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
    let inset = rect.insetBy(dx: 100, dy: 100)
    let body = NSBezierPath(roundedRect: inset, xRadius: 185, yRadius: 185)
    NSGradient(starting: NSColor(white: 0.20, alpha: 1), ending: NSColor(white: 0.07, alpha: 1))!
        .draw(in: body, angle: -90)

    // Grille-cloth texture.
    NSGraphicsContext.current?.saveGraphicsState()
    body.addClip()
    NSColor(white: 1, alpha: 0.035).setStroke()
    for x in stride(from: inset.minX - inset.height, to: inset.maxX, by: 18) {
        let line = NSBezierPath()
        line.move(to: NSPoint(x: x, y: inset.minY))
        line.line(to: NSPoint(x: x + inset.height, y: inset.maxY))
        line.lineWidth = 6
        line.stroke()
    }
    NSGraphicsContext.current?.restoreGraphicsState()

    let center = NSPoint(x: rect.midX, y: rect.midY - 20)

    // Scale ticks 1–10.
    NSColor(white: 0.85, alpha: 1).setStroke()
    for i in 0..<10 {
        let angle = (225.0 - Double(i) * 30.0) * .pi / 180
        let tick = NSBezierPath()
        tick.move(to: NSPoint(x: center.x + cos(angle) * 250, y: center.y + sin(angle) * 250))
        tick.line(to: NSPoint(x: center.x + cos(angle) * 290, y: center.y + sin(angle) * 290))
        tick.lineWidth = 16
        tick.lineCapStyle = .round
        tick.stroke()
    }

    // Knob.
    let knob = NSBezierPath(ovalIn: NSRect(x: center.x - 200, y: center.y - 200, width: 400, height: 400))
    NSGradient(colors: [NSColor(white: 0.95, alpha: 1), NSColor(white: 0.55, alpha: 1), NSColor(white: 0.85, alpha: 1)])!
        .draw(in: knob, angle: -60)
    NSColor(white: 0.3, alpha: 1).setStroke()
    knob.lineWidth = 6
    knob.stroke()

    // Pointer at "8".
    let angle = (225.0 - 7 * 30.0) * .pi / 180
    let pointer = NSBezierPath()
    pointer.move(to: NSPoint(x: center.x + cos(angle) * 40, y: center.y + sin(angle) * 40))
    pointer.line(to: NSPoint(x: center.x + cos(angle) * 180, y: center.y + sin(angle) * 180))
    pointer.lineWidth = 30
    pointer.lineCapStyle = .round
    NSColor(calibratedRed: 0.86, green: 0.16, blue: 0.14, alpha: 1).setStroke()
    pointer.stroke()
    return true
}

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
