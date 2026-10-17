package com.mirror.server;

/** Parses `key=value` arguments passed on the app_process command line. */
final class Options {
    String scid;
    int maxSize = 0;
    int bitRate = 8_000_000;
    float maxFps = 0;
    /** "cbr", "vbr" or "default" (leave it to the encoder). */
    String bitrateMode = "default";
    /** Forward the phone's sound on a third socket. */
    boolean audio = false;

    static Options parse(String[] args) {
        Options o = new Options();
        for (String arg : args) {
            int eq = arg.indexOf('=');
            if (eq < 0) {
                throw new IllegalArgumentException("Expected key=value, got: " + arg);
            }
            String key = arg.substring(0, eq);
            String value = arg.substring(eq + 1);
            switch (key) {
                case "scid": o.scid = value; break;
                // Identifies the desktop install; only used by the desktop to find its own servers.
                case "owner": break;
                case "max_size": o.maxSize = Integer.parseInt(value); break;
                case "bit_rate": o.bitRate = Integer.parseInt(value); break;
                case "max_fps": o.maxFps = Float.parseFloat(value); break;
                case "bitrate_mode": o.bitrateMode = value; break;
                case "audio": o.audio = "1".equals(value) || "true".equals(value); break;
                default: Ln.w("Unknown option ignored: " + key);
            }
        }
        if (o.scid == null || !o.scid.matches("[0-9a-f]{8}")) {
            throw new IllegalArgumentException("scid must be 8 lowercase hex chars");
        }
        return o;
    }
}
