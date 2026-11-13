package org.dsh.community.android.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import org.dsh.community.android.protocol.PromptImageAttachment
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Compresses selected gallery images into bounded JPEG attachments that fit comfortably inside
 * the 64 KiB wire frame cap across LAN, WebRTC DataChannel, and Blind Relay.
 */
object PromptImageHelper {
    const val MAX_ATTACHMENTS = 2
    const val MAX_SINGLE_IMAGE_BYTES = 14_500
    const val MAX_TOTAL_IMAGE_BYTES = 28_000
    const val MAX_DIMENSION_PX = 960

    fun computeScaledDimensions(
        width: Int,
        height: Int,
        maxDimension: Int = MAX_DIMENSION_PX,
    ): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return 1 to 1
        val largest = max(width, height)
        if (largest <= maxDimension) return width to height
        val scale = maxDimension.toDouble() / largest.toDouble()
        val outW = max(1, (width * scale).roundToInt())
        val outH = max(1, (height * scale).roundToInt())
        return outW to outH
    }

    fun buildAttachment(
        mediaType: String,
        rawBytes: ByteArray,
        name: String? = null,
    ): PromptImageAttachment {
        require(mediaType in setOf("image/jpeg", "image/png", "image/webp", "image/gif")) {
            "Unsupported image mediaType: $mediaType"
        }
        require(rawBytes.isNotEmpty()) { "Image byte payload must not be empty" }
        require(rawBytes.size <= MAX_TOTAL_IMAGE_BYTES) {
            "Compressed image exceeds ${MAX_TOTAL_IMAGE_BYTES} byte limit (${rawBytes.size} bytes)"
        }
        val b64 = Base64.getEncoder().encodeToString(rawBytes)
        val cleanName = name?.trim()?.takeIf { it.isNotEmpty() }?.take(120)
        return PromptImageAttachment(
            mediaType = mediaType,
            dataBase64 = b64,
            name = cleanName,
        )
    }

    fun compressUriToAttachment(
        context: Context,
        uri: Uri,
        maxBytes: Int = MAX_SINGLE_IMAGE_BYTES,
    ): PromptImageAttachment {
        val resolver = context.contentResolver
        val fileName = resolveDisplayName(context, uri) ?: "photo.jpg"

        val boundsOpts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { stream ->
            BitmapFactory.decodeStream(stream, null, boundsOpts)
        } ?: throw IllegalArgumentException("Unable to open selected image")

        if (boundsOpts.outWidth <= 0 || boundsOpts.outHeight <= 0) {
            throw IllegalArgumentException("Selected file is not a valid image")
        }

        var sampleSize = 1
        val rawMax = max(boundsOpts.outWidth, boundsOpts.outHeight)
        while (rawMax / (sampleSize * 2) >= MAX_DIMENSION_PX) {
            sampleSize *= 2
        }

        val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sampleSize }
        val decoded = resolver.openInputStream(uri)?.use { stream ->
            BitmapFactory.decodeStream(stream, null, decodeOpts)
        } ?: throw IllegalArgumentException("Unable to decode selected image")

        var working = decoded
        try {
            val (initW, initH) = computeScaledDimensions(decoded.width, decoded.height, MAX_DIMENSION_PX)
            if (initW != decoded.width || initH != decoded.height) {
                working = Bitmap.createScaledBitmap(decoded, initW, initH, true)
                if (working !== decoded) decoded.recycle()
            }

            var bestBytes: ByteArray? = null
            var curMaxDim = MAX_DIMENSION_PX
            for (scalePass in 0 until 4) {
                for (quality in intArrayOf(82, 68, 54, 40, 28)) {
                    val out = ByteArrayOutputStream()
                    working.compress(Bitmap.CompressFormat.JPEG, quality, out)
                    val candidate = out.toByteArray()
                    if (bestBytes == null || candidate.size < bestBytes.size) {
                        bestBytes = candidate
                    }
                    if (candidate.size <= maxBytes) {
                        return buildAttachment("image/jpeg", candidate, normalizeJpgName(fileName))
                    }
                }
                curMaxDim = max(160, (curMaxDim * 0.65).roundToInt())
                val (nextW, nextH) = computeScaledDimensions(working.width, working.height, curMaxDim)
                if (nextW == working.width && nextH == working.height) break
                val resized = Bitmap.createScaledBitmap(working, nextW, nextH, true)
                if (resized !== working) {
                    working.recycle()
                    working = resized
                }
            }
            val finalBytes = bestBytes ?: throw IllegalArgumentException("Failed to compress image")
            return buildAttachment("image/jpeg", finalBytes, normalizeJpgName(fileName))
        } finally {
            if (!working.isRecycled) {
                working.recycle()
            }
        }
    }

    private fun resolveDisplayName(context: Context, uri: Uri): String? {
        return try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) cursor.getString(idx) else null
                } else {
                    null
                }
            }
        } catch (_: Throwable) {
            uri.lastPathSegment
        }
    }

    private fun normalizeJpgName(raw: String): String {
        val base = raw.substringAfterLast('/').trim().ifEmpty { "photo" }
        val stem = base.substringBeforeLast('.', base).ifEmpty { "photo" }.take(52)
        return "$stem.jpg"
    }
}
