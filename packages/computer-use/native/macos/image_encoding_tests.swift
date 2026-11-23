import CoreGraphics
import Foundation
import ImageIO

/// Drive the screenshot encoding helpers (`downscaledImage`, `jpegData`) on in-memory bitmaps. Nothing
/// is captured from a display or window. Quality is pinned by behavior: a noise bitmap must encode
/// strictly larger at a high quality than at a low one, which fails if the quality never reaches ImageIO.
func runImageEncodingAssertions() {
    let bridge = Bridge(activityGlow: nil, readSession: { nil }, inputSink: forbiddenInputSink)
    guard let image = solidImage(width: 40, height: 20) else {
        expect(false, "a 40x20 RGBA bitmap context builds")
        return
    }
    expect(bridge.downscaledImage(image, maxDimension: nil) == nil, "no limit keeps the original")
    expect(bridge.downscaledImage(image, maxDimension: 40) == nil, "a limit equal to the longest side keeps the original")
    expect(bridge.downscaledImage(image, maxDimension: 80) == nil, "a limit above the longest side keeps the original")
    for (limit, width, height) in [(39, 39, 19), (10, 10, 5), (1, 1, 1)] {
        let scaled = bridge.downscaledImage(image, maxDimension: limit)
        expect(scaled?.width == width && scaled?.height == height, "limit \(limit) scales 40x20 to \(width)x\(height), keeping at least one pixel")
        expect(scaled?.bitsPerComponent == image.bitsPerComponent, "a scaled image keeps its component depth")
    }
    if let scaled = bridge.downscaledImage(image, maxDimension: 10) {
        expect(centerPixel(scaled) == [255, 0, 0, 255], "a scaled solid image keeps its color")
    }

    guard let jpeg = bridge.jpegData(image: image, quality: 0.8) else {
        expect(false, "a bitmap encodes as JPEG")
        return
    }
    expect(Array(jpeg.prefix(3)) == [0xFF, 0xD8, 0xFF] && Array(jpeg.suffix(2)) == [0xFF, 0xD9], "the encoding is one JPEG stream")
    let source = CGImageSourceCreateWithData(jpeg as CFData, nil)
    expect(source.flatMap(CGImageSourceGetType) as String? == "public.jpeg", "ImageIO reads the data as JPEG")
    let decoded = source.flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
    expect(decoded?.width == 40 && decoded?.height == 20, "the JPEG keeps the bitmap's size")
    guard let noise = noiseImage(side: 64) else {
        expect(false, "a 64x64 noise bitmap builds")
        return
    }
    let low = bridge.jpegData(image: noise, quality: 0.1)?.count ?? 0
    let high = bridge.jpegData(image: noise, quality: 1.0)?.count ?? 0
    expect(low > 0 && high > low, "the quality reaches the encoder: noise at 1.0 encodes larger than at 0.1 (\(high) vs \(low) bytes)")
    print("macos image encoding assertions passed")
}

private func solidImage(width: Int, height: Int) -> CGImage? {
    guard let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()
}

/// A square of deterministic pseudo-random pixels: detail JPEG cannot drop without the quality setting.
private func noiseImage(side: Int) -> CGImage? {
    guard let context = CGContext(
        data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ), let pixels = context.data?.bindMemory(to: UInt8.self, capacity: context.bytesPerRow * side) else { return nil }
    var state: UInt32 = 0x9E37_79B9
    for offset in 0..<(context.bytesPerRow * side) {
        state = state &* 1_664_525 &+ 1_013_904_223
        pixels[offset] = UInt8(truncatingIfNeeded: state >> 24)
    }
    return context.makeImage()
}

/// RGBA bytes of the center pixel, redrawn into a known premultiplied RGBA layout.
private func centerPixel(_ image: CGImage) -> [UInt8] {
    var pixel = [UInt8](repeating: 0, count: 4)
    pixel.withUnsafeMutableBytes { buffer in
        guard let context = CGContext(
            data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return }
        context.draw(image, in: CGRect(x: -image.width / 2, y: -image.height / 2, width: image.width, height: image.height))
    }
    return pixel
}
