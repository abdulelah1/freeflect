package com.mirror.server;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaRecorder;
import android.os.Build;

import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Captures the phone's audio output (REMOTE_SUBMIX, which also silences the
 * phone's speaker) and streams it as AAC-LC, 48 kHz stereo. Timestamps use the
 * same clock as the video encoder (System.nanoTime) so the desktop can keep
 * sound and picture in sync.
 */
final class AudioEncoder {
    static final int CODEC_AAC = 0x00616163; // "\0aac"
    private static final int SAMPLE_RATE = 48_000;
    private static final int CHANNELS = 2;
    private static final int BIT_RATE = 128_000;
    private static final int BYTES_PER_FRAME = CHANNELS * 2; // 16-bit PCM
    private static final long FLAG_CONFIG = 1L << 63;

    private final DataOutputStream out;
    private volatile boolean running = true;

    AudioEncoder(DataOutputStream out) {
        this.out = out;
    }

    void stop() {
        running = false;
    }

    /** Null when audio can be captured on this phone, else a reason for the user. */
    static String unsupportedReason() {
        if (Build.VERSION.SDK_INT < 31) return "Sound forwarding needs Android 12 or later";
        return null;
    }

    void run() throws IOException {
        AudioRecord recorder = null;
        MediaCodec codec = null;
        try {
            recorder = createRecorder();
            codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
            MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, CHANNELS);
            format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            format.setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE);
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            codec.start();
            recorder.startRecording();
            Ln.i("Capturing audio with " + codec.getName());
            encode(recorder, codec);
        } catch (Exception e) {
            // Audio is optional: report and let video continue.
            Ln.e("Audio capture stopped", e);
        } finally {
            if (recorder != null) {
                try {
                    recorder.stop();
                } catch (IllegalStateException ignored) {
                    // Never started.
                }
                recorder.release();
            }
            if (codec != null) {
                try {
                    codec.stop();
                } catch (IllegalStateException ignored) {
                    // Never started.
                }
                codec.release();
            }
        }
    }

    private static AudioRecord createRecorder() throws ReflectiveOperationException {
        Workarounds.apply();
        AudioFormat format = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                .build();
        int minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        return new AudioRecord.Builder()
                .setContext(FakeContext.get())
                .setAudioSource(MediaRecorder.AudioSource.REMOTE_SUBMIX)
                .setAudioFormat(format)
                .setBufferSizeInBytes(8 * minBuffer)
                .build();
    }

    private void encode(AudioRecord recorder, MediaCodec codec) throws IOException {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long startUs = System.nanoTime() / 1000;
        long frames = 0;
        byte[] chunk = new byte[0];
        while (running) {
            int in = codec.dequeueInputBuffer(10_000);
            if (in >= 0) {
                ByteBuffer buffer = codec.getInputBuffer(in);
                int read = recorder.read(buffer, buffer.remaining());
                if (read < 0) throw new IOException("AudioRecord.read failed: " + read);
                long ptsUs = startUs + frames * 1_000_000L / SAMPLE_RATE;
                frames += read / BYTES_PER_FRAME;
                codec.queueInputBuffer(in, 0, read, ptsUs, 0);
            }
            int outIndex;
            while ((outIndex = codec.dequeueOutputBuffer(info, 0)) >= 0) {
                try {
                    if (info.size == 0) continue;
                    ByteBuffer buffer = codec.getOutputBuffer(outIndex);
                    if (chunk.length < info.size) chunk = new byte[info.size];
                    buffer.position(info.offset);
                    buffer.get(chunk, 0, info.size);
                    long header = info.presentationTimeUs & ~FLAG_CONFIG;
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) header |= FLAG_CONFIG;
                    synchronized (out) {
                        out.writeLong(header);
                        out.writeInt(info.size);
                        out.write(chunk, 0, info.size);
                        out.flush();
                    }
                } finally {
                    codec.releaseOutputBuffer(outIndex, false);
                }
            }
        }
    }
}
