package com.mirror.server;

import android.os.Build;
import android.os.IBinder;

import java.lang.reflect.Method;

/**
 * Turns the phone's physical screen off (or back on) while mirroring keeps
 * running: the virtual display used for capture is unaffected.
 */
final class DisplayPower {
    static final int POWER_MODE_OFF = 0;
    static final int POWER_MODE_NORMAL = 2;

    private static Class<?> displayControl;

    private DisplayPower() {}

    static boolean set(boolean on) {
        try {
            Class<?> sc = Class.forName("android.view.SurfaceControl");
            Method setMode = sc.getMethod("setDisplayPowerMode", IBinder.class, int.class);
            boolean ok = false;
            for (IBinder token : physicalDisplayTokens(sc)) {
                setMode.invoke(null, token, on ? POWER_MODE_NORMAL : POWER_MODE_OFF);
                ok = true;
            }
            Ln.i("Phone screen " + (on ? "on" : "off"));
            return ok;
        } catch (ReflectiveOperationException e) {
            Ln.e("Could not change the screen power", e);
            return false;
        }
    }

    private static IBinder[] physicalDisplayTokens(Class<?> sc) throws ReflectiveOperationException {
        if (Build.VERSION.SDK_INT >= 34) {
            // Android 14 moved these to DisplayControl in services.jar.
            Class<?> dc = displayControl();
            long[] ids = (long[]) dc.getMethod("getPhysicalDisplayIds").invoke(null);
            Method token = dc.getMethod("getPhysicalDisplayToken", long.class);
            IBinder[] tokens = new IBinder[ids.length];
            for (int i = 0; i < ids.length; i++) tokens[i] = (IBinder) token.invoke(null, ids[i]);
            return tokens;
        }
        if (Build.VERSION.SDK_INT >= 29) {
            long[] ids = (long[]) sc.getMethod("getPhysicalDisplayIds").invoke(null);
            Method token = sc.getMethod("getPhysicalDisplayToken", long.class);
            IBinder[] tokens = new IBinder[ids.length];
            for (int i = 0; i < ids.length; i++) tokens[i] = (IBinder) token.invoke(null, ids[i]);
            return tokens;
        }
        return new IBinder[] {(IBinder) sc.getMethod("getBuiltInDisplay", int.class).invoke(null, 0)};
    }

    private static synchronized Class<?> displayControl() throws ReflectiveOperationException {
        if (displayControl != null) return displayControl;
        Class<?> factory = Class.forName("com.android.internal.os.ClassLoaderFactory");
        Method create = factory.getDeclaredMethod("createClassLoader", String.class, String.class, String.class,
                ClassLoader.class, int.class, boolean.class, String.class);
        ClassLoader loader = (ClassLoader) create.invoke(null, "/system/framework/services.jar", null, null,
                ClassLoader.getSystemClassLoader(), 0, true, null);
        Class<?> dc = loader.loadClass("com.android.server.display.DisplayControl");
        // Its native methods live in libandroid_servers, loaded for that class loader.
        Method loadLibrary = Runtime.class.getDeclaredMethod("loadLibrary0", Class.class, String.class);
        loadLibrary.setAccessible(true);
        loadLibrary.invoke(Runtime.getRuntime(), dc, "android_servers");
        displayControl = dc;
        return dc;
    }
}
