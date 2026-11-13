package org.dsh.community.android.qr

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.nio.ByteBuffer

/**
 * Pure JVM + ZXing Y-plane QR code decoder (CameraX YUV_420_888 compatible, no native OpenCV/MLKit).
 */
object QrImageDecoder {
    private val DECODE_HINTS: Map<DecodeHintType, Any> = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        DecodeHintType.TRY_HARDER to true,
        DecodeHintType.CHARACTER_SET to "UTF-8",
    )

    fun extractYPlaneBytes(
        buffer: ByteBuffer,
        width: Int,
        height: Int,
        rowStride: Int,
        pixelStride: Int,
    ): ByteArray {
        val dup = buffer.duplicate()
        dup.rewind()
        val raw = ByteArray(dup.remaining())
        dup.get(raw)
        return extractTightYPlane(raw, width, height, rowStride, pixelStride)
    }

    fun extractTightYPlane(
        yBytes: ByteArray,
        width: Int,
        height: Int,
        rowStride: Int,
        pixelStride: Int,
    ): ByteArray {
        if (width <= 0 || height <= 0) return ByteArray(0)
        if (pixelStride == 1 && rowStride == width && yBytes.size >= width * height) {
            return yBytes.copyOf(width * height)
        }
        val tight = ByteArray(width * height)
        val safeRowStride = maxOf(rowStride, width * maxOf(pixelStride, 1))
        for (row in 0 until height) {
            val rowStart = row * safeRowStride
            val dstRowStart = row * width
            if (pixelStride == 1) {
                val available = (yBytes.size - rowStart).coerceIn(0, width)
                if (available > 0) {
                    System.arraycopy(yBytes, rowStart, tight, dstRowStart, available)
                }
            } else {
                for (col in 0 until width) {
                    val srcIdx = rowStart + col * pixelStride
                    if (srcIdx < yBytes.size) {
                        tight[dstRowStart + col] = yBytes[srcIdx]
                    }
                }
            }
        }
        return tight
    }

    fun decodeYPlane(
        yBytes: ByteArray,
        width: Int,
        height: Int,
        rowStride: Int = width,
        pixelStride: Int = 1,
    ): String? {
        if (width <= 0 || height <= 0) return null
        val tight = extractTightYPlane(yBytes, width, height, rowStride, pixelStride)
        if (tight.size < width * height) return null

        val source = PlanarYUVLuminanceSource(
            tight,
            width,
            height,
            0,
            0,
            width,
            height,
            false,
        )
        val reader = QRCodeReader()
        val candidates = listOf(source, source.invert())
        for (candidate in candidates) {
            try {
                val bitmap = BinaryBitmap(HybridBinarizer(candidate))
                val decoded = reader.decode(bitmap, DECODE_HINTS)?.text
                if (!decoded.isNullOrBlank()) {
                    return decoded
                }
            } catch (_: Throwable) {
                // Continue trying inverted or next frame.
            } finally {
                reader.reset()
            }
        }
        return null
    }
}
