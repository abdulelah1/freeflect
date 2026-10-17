package com.mirror.server;

/** Logs go to stdout, which the desktop reads from the adb shell stream. */
final class Ln {
    private Ln() {}

    static void i(String msg) { System.out.println("[server] I " + msg); }
    static void w(String msg) { System.out.println("[server] W " + msg); }
    static void e(String msg, Throwable t) {
        System.out.println("[server] E " + msg + (t != null ? ": " + t : ""));
        if (t != null) t.printStackTrace(System.out);
    }
}
