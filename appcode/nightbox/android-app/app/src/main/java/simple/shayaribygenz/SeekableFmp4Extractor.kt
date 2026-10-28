package simple.shayaribygenz

import android.net.Uri
import android.util.Log
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorInput
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.SeekPoint
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.mp4.FragmentedMp4Extractor
import androidx.media3.extractor.DefaultExtractorsFactory
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

@UnstableApi
class Fmp4FragmentIndex {
    private val fragments = CopyOnWriteArrayList<SeekPoint>()

    fun addFragment(timeUs: Long, byteOffset: Long) {
        fragments.add(SeekPoint(timeUs, byteOffset))
    }

    fun setFragments(list: List<SeekPoint>) {
        fragments.clear()
        fragments.addAll(list.sortedBy { it.timeUs })
    }

    fun hasFragments(): Boolean = fragments.isNotEmpty()

    fun getSeekPoint(timeUs: Long): SeekPoint? {
        val list = fragments
        if (list.isEmpty()) return null
        if (timeUs <= list.first().timeUs) return list.first()
        if (timeUs >= list.last().timeUs) return list.last()

        var low = 0
        var high = list.size - 1
        var bestIndex = 0

        while (low <= high) {
            val mid = (low + high) ushr 1
            val midPoint = list[mid]
            if (midPoint.timeUs <= timeUs) {
                bestIndex = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return list[bestIndex]
    }
}

@UnstableApi
class Fmp4DynamicSeekMap(
    private val durationUs: Long,
    private val contentLength: Long,
    private val fragmentIndex: Fmp4FragmentIndex
) : SeekMap {
    override fun isSeekable(): Boolean = true
    override fun getDurationUs(): Long = durationUs

    override fun getSeekPoints(timeUs: Long): SeekMap.SeekPoints {
        if (timeUs <= 0L || durationUs <= 0L) {
            return SeekMap.SeekPoints(SeekPoint(0L, 0L))
        }

        val exact = fragmentIndex.getSeekPoint(timeUs)
        if (exact != null) {
            return SeekMap.SeekPoints(exact)
        }

        val firstMoof = 1479L
        val maxLen = if (contentLength > firstMoof) contentLength else 11_220_967L
        val fraction = (timeUs.toDouble() / durationUs.toDouble()).coerceIn(0.0, 1.0)
        val estOffset = (firstMoof + (fraction * (maxLen - firstMoof)).toLong())
        val safeOffset = (estOffset - 32_768L).coerceAtLeast(firstMoof)
        return SeekMap.SeekPoints(SeekPoint(timeUs, safeOffset))
    }
}

@UnstableApi
class SeekableFmp4Extractor(
    private val delegate: FragmentedMp4Extractor,
    private val durationUsProvider: () -> Long,
    private val contentLengthProvider: () -> Long,
    private val fragmentIndex: Fmp4FragmentIndex
) : Extractor {

    companion object {
        private const val TAG = "SeekableFmp4Extractor"
    }

    @Volatile
    private var needsMoofScan = false

    override fun sniff(input: ExtractorInput): Boolean {
        return delegate.sniff(input)
    }

    override fun init(output: ExtractorOutput) {
        val wrappedOutput = object : ExtractorOutput {
            override fun track(id: Int, type: Int): TrackOutput {
                return output.track(id, type)
            }

            override fun endTracks() {
                output.endTracks()
            }

            override fun seekMap(seekMap: SeekMap) {
                val durUs = durationUsProvider().takeIf { it > 0L } ?: seekMap.durationUs
                val cl = contentLengthProvider()
                val seekable = if (!seekMap.isSeekable && durUs > 0L) {
                    Fmp4DynamicSeekMap(durUs, cl, fragmentIndex)
                } else {
                    seekMap
                }
                output.seekMap(seekable)
            }
        }
        delegate.init(wrappedOutput)
    }

    override fun seek(position: Long, timeUs: Long) {
        if (position > 0L) {
            needsMoofScan = true
        } else {
            needsMoofScan = false
        }
        delegate.seek(position, timeUs)
    }

    @Throws(IOException::class)
    override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int {
        if (needsMoofScan) {
            alignToNextMoof(input)
            needsMoofScan = false
        }
        return delegate.read(input, seekPosition)
    }

    override fun release() {
        delegate.release()
    }

    @Throws(IOException::class)
    private fun alignToNextMoof(input: ExtractorInput) {
        val startPos = input.position
        if (startPos <= 0L) return

        val buffer = ByteArray(8192)
        var totalScanned = 0
        val maxScanBytes = 512 * 1024

        while (totalScanned < maxScanBytes) {
            input.resetPeekPosition()
            val peeked = input.peek(buffer, 0, buffer.size)
            if (peeked <= 0 || peeked < 16) {
                input.resetPeekPosition()
                return
            }

            var foundOffset = -1
            for (i in 0..(peeked - 16)) {
                if (buffer[i + 4] == 'm'.code.toByte() &&
                    buffer[i + 5] == 'o'.code.toByte() &&
                    buffer[i + 6] == 'o'.code.toByte() &&
                    buffer[i + 7] == 'f'.code.toByte() &&
                    buffer[i + 12] == 'm'.code.toByte() &&
                    buffer[i + 13] == 'f'.code.toByte() &&
                    buffer[i + 14] == 'h'.code.toByte() &&
                    buffer[i + 15] == 'd'.code.toByte()
                ) {
                    foundOffset = i
                    break
                }
            }

            if (foundOffset != -1) {
                input.resetPeekPosition()
                if (foundOffset > 0) {
                    input.skipFully(foundOffset)
                }
                Log.d(TAG, "Aligned to moof: skipped $foundOffset bytes (total $totalScanned) at position ${input.position}")
                return
            }

            val advance = (peeked - 15).coerceAtLeast(1)
            input.resetPeekPosition()
            input.skipFully(advance)
            totalScanned += advance
        }
        input.resetPeekPosition()
        Log.w(TAG, "Could not find moof within $maxScanBytes bytes from $startPos")
    }
}

@UnstableApi
class SeekableFmp4ExtractorsFactory(
    private val durationUsProvider: () -> Long,
    private val contentLengthProvider: () -> Long,
    private val fragmentIndex: Fmp4FragmentIndex
) : ExtractorsFactory {
    @Suppress("DEPRECATION")
    override fun createExtractors(): Array<Extractor> {
        val flags = FragmentedMp4Extractor.FLAG_WORKAROUND_EVERY_VIDEO_FRAME_IS_SYNC_FRAME
        val baseFmp4 = FragmentedMp4Extractor(flags)
        val seekableFmp4 = SeekableFmp4Extractor(
            baseFmp4,
            durationUsProvider,
            contentLengthProvider,
            fragmentIndex
        )
        val defaultExtractors = DefaultExtractorsFactory().createExtractors()
        return arrayOf(seekableFmp4, *defaultExtractors)
    }

    override fun createExtractors(uri: Uri, responseHeaders: Map<String, List<String>>): Array<Extractor> {
        return createExtractors()
    }
}
