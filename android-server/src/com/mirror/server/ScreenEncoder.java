package com.mirror.server;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Bundle;
import android.view.Surface;

import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

/** Captures display 0 into a hardware H.264 encoder and streams packets. */
final class ScreenEncoder {
    private static final long FLAG_CONFIG = 1L << 63;
    private static final long FLAG_KEY = 1L << 62;
    private static final long SESSION_MARKER = -1L;
    /** Sizes to fall back to when the encoder rejects the native resolution. */
    private static final int[] FALLBACK_MAX_SIZES = {2560, 1920, 1600, 1280, 1024, 800};

    private final Options options;
    private final DataOutputStream out;
    private static final long DISPLAY_POLL_MS = 300;

    private final AtomicBoolean keyframeRequested = new AtomicBoolean();
    private volatile boolean running = true;
    /** Latest display geometry; also used by the controller to map touches. */
    private volatile Hidden.DisplayInfo display;

    ScreenEncoder(Options options, DataOutputStream out) {
        this.options = options;
        this.out = out;
    }

    void requestKeyframe() {
        keyframeRequested.set(true);
    }

    void stop() {
        running = false;
    }

    Hidden.DisplayInfo display() {
        return display;
    }

    void run() throws Exception {
        display = Hidden.getDisplayInfo(0);
        int maxSize = options.maxSize;
        int fallback = 0;
        while (running) {
            display = Hidden.getDisplayInfo(0);
            int[] size = scaledSize(display.width, display.height, maxSize);
            try {
                // Returns normally when the display size changes (rotation);
                // the loop then restarts the encoder at the new size.
                encode(display, size[0], size[1]);
            } catch (IllegalStateException | IllegalArgumentException e) {
                // MediaCodec.CodecException extends IllegalStateException.
                while (fallback < FALLBACK_MAX_SIZES.length
                        && FALLBACK_MAX_SIZES[fallback] >= Math.max(size[0], size[1])) {
                    fallback++;
                }
                if (fallback >= FALLBACK_MAX_SIZES.length) throw e;
                maxSize = FALLBACK_MAX_SIZES[fallback++];
                Ln.w("Encoder rejected " + size[0] + "x" + size[1] + " (" + e + "), retrying with max_size=" + maxSize);
            }
        }
    }

    private void encode(Hidden.DisplayInfo display, int width, int height) throws Exception {
        MediaCodec codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        Hidden.Mirror mirror = null;
        try {
            MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
            format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            format.setInteger(MediaFormat.KEY_BIT_RATE, options.bitRate);
            format.setInteger(MediaFormat.KEY_FRAME_RATE, 60);
            format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10);
            // Ask for SPS/PPS before every keyframe (API 29+, honoured by some
            // vendors only; the desktop also re-inserts them).
            format.setInteger(MediaFormat.KEY_PREPEND_HEADER_TO_SYNC_FRAMES, 1);
            // Keep producing frames on a static screen so the desktop never stalls.
            format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000);
            if ("cbr".equals(options.bitrateMode)) {
                format.setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR);
            } else if ("vbr".equals(options.bitrateMode)) {
                format.setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR);
            }
            if (options.maxFps > 0) {
                format.setFloat("max-fps-to-encoder", options.maxFps);
            }
            try {
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            } catch (IllegalArgumentException e) {
                // Some encoders (e.g. the emulator's software AVC encoder) reject
                // the optional prepend-header key; the desktop re-inserts headers anyway.
                Ln.w("Encoder rejected optional settings, retrying without them: " + e);
                format.removeKey(MediaFormat.KEY_PREPEND_HEADER_TO_SYNC_FRAMES);
                codec.reset();
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            }
            Surface surface = codec.createInputSurface();
            mirror = Hidden.mirrorDisplay("mirror", width, height, surface, display);
            codec.start();
            Ln.i("Encoding " + width + "x" + height + " with " + codec.getName());

            synchronized (out) {
                out.writeLong(SESSION_MARKER);
                out.writeShort(width);
                out.writeShort(height);
                out.flush();
            }
            drain(codec);
        } finally {
            if (mirror != null) mirror.release();
            try {
                codec.stop();
            } catch (IllegalStateException ignored) {
                // Not started because configure failed.
            }
            codec.release();
        }
    }

    private void drain(MediaCodec codec) throws IOException, ReflectiveOperationException {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        byte[] chunk = new byte[0];
        Hidden.DisplayInfo started = display;
        long nextPoll = System.currentTimeMillis() + DISPLAY_POLL_MS;
        while (running) {
            if (System.currentTimeMillis() >= nextPoll) {
                nextPoll += DISPLAY_POLL_MS;
                Hidden.DisplayInfo now = Hidden.getDisplayInfo(0);
                display = now;
                if (now.width != started.width || now.height != started.height) {
                    Ln.i("Display changed to " + now.width + "x" + now.height + ", restarting encoder");
                    return;
                }
            }
            if (keyframeRequested.getAndSet(false)) {
                Bundle params = new Bundle();
                params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
                codec.setParameters(params);
            }
            int index = codec.dequeueOutputBuffer(info, 100_000);
            if (index < 0) continue;
            try {
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
                if (info.size == 0) continue;
                ByteBuffer buffer = codec.getOutputBuffer(index);
                if (chunk.length < info.size) chunk = new byte[info.size];
                buffer.position(info.offset);
                buffer.get(chunk, 0, info.size);

                long header = info.presentationTimeUs & ~(FLAG_CONFIG | FLAG_KEY);
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) header |= FLAG_CONFIG;
                if ((info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0) header |= FLAG_KEY;
                synchronized (out) {
                    out.writeLong(header);
                    out.writeInt(info.size);
                    out.write(chunk, 0, info.size);
                    out.flush();
                }
            } finally {
                codec.releaseOutputBuffer(index, false);
            }
        }
    }

    /** Scales so the long side is at most {@code maxSize}; both sides become multiples of 8. */
    static int[] scaledSize(int w, int h, int maxSize) {
        int longSide = Math.max(w, h);
        if (maxSize > 0 && longSide > maxSize) {
            double scale = (double) maxSize / longSide;
            w = (int) Math.round(w * scale);
            h = (int) Math.round(h * scale);
        }
        return new int[] {w & ~7, h & ~7};
    }
}
