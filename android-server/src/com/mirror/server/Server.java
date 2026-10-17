package com.mirror.server;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Build;
import android.os.Looper;

import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Entry point, started by the desktop with app_process. See docs/protocol.md.
 */
public final class Server {
    private static final int PROTOCOL_VERSION = 1;

    private Server() {}

    public static void main(String[] args) {
        try {
            run(Options.parse(args));
        } catch (Throwable t) {
            Ln.e("Fatal", t);
            System.exit(1);
        }
        // Encoder/codec threads may linger; the session is over.
        System.exit(0);
    }

    private static void run(Options options) throws Exception {
        Looper.prepareMainLooper();
        String audioProblem = options.audio ? AudioEncoder.unsupportedReason() : null;
        if (options.audio && audioProblem == null) {
            // ActivityThread needs a Looper on the thread that creates it.
            try {
                Workarounds.apply();
            } catch (Exception e) {
                // Sound is optional; keep mirroring without it.
                Ln.e("Sound capture setup failed", e);
                audioProblem = "Sound capture is not available on this phone";
            }
        }
        String socketName = "mirror_" + options.scid;
        Ln.i("Listening on @" + socketName + " (Android " + Build.VERSION.RELEASE + ", SDK " + Build.VERSION.SDK_INT + ")");

        try (LocalServerSocket server = new LocalServerSocket(socketName);
             LocalSocket video = server.accept();
             LocalSocket control = acceptAfterHandshake(server, video);
             LocalSocket audio = options.audio ? server.accept() : null) {

            ScreenEncoder encoder = new ScreenEncoder(options,
                    new DataOutputStream(new BufferedOutputStream(video.getOutputStream(), 1 << 16)));
            Controller controller = new Controller(new DataInputStream(control.getInputStream()),
                    new DataOutputStream(control.getOutputStream()), encoder);

            Thread controlThread = new Thread(() -> {
                try {
                    controller.run();
                } catch (Exception e) {
                    Ln.e("Controller stopped", e);
                }
                // Desktop went away: stop encoding so the process exits.
                encoder.stop();
            }, "control");
            controlThread.setDaemon(true);
            controlThread.start();

            if (audio != null) startAudio(audio, audioProblem);

            encoder.run();
        }
        Ln.i("Session ended");
    }

    /**
     * Audio socket: a 4-byte codec id (0 = unavailable, followed by a
     * length-prefixed reason), then packets in the video packet format.
     */
    private static void startAudio(LocalSocket socket, String reason) throws java.io.IOException {
        DataOutputStream out = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream(), 1 << 14));
        if (reason != null) {
            byte[] bytes = reason.getBytes(StandardCharsets.UTF_8);
            out.writeInt(0);
            out.writeByte(bytes.length);
            out.write(bytes);
            out.flush();
            Ln.w(reason);
            return;
        }
        out.writeInt(AudioEncoder.CODEC_AAC);
        out.flush();
        AudioEncoder encoder = new AudioEncoder(out);
        Thread thread = new Thread(() -> {
            try {
                encoder.run();
            } catch (java.io.IOException e) {
                Ln.i("Audio socket closed");
            }
        }, "audio");
        thread.setDaemon(true);
        thread.start();
    }

    /** The handshake confirms to the desktop that the forward reached a live server. */
    private static LocalSocket acceptAfterHandshake(LocalServerSocket server, LocalSocket video) throws Exception {
        DataOutputStream out = new DataOutputStream(video.getOutputStream());
        byte[] name = (Build.MANUFACTURER + " " + Build.MODEL).getBytes(StandardCharsets.UTF_8);
        int nameLen = Math.min(name.length, 255);
        out.writeBytes("MIRR");
        out.writeByte(PROTOCOL_VERSION);
        out.writeByte(nameLen);
        out.write(name, 0, nameLen);
        out.flush();
        return server.accept();
    }
}
