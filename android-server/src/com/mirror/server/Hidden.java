package com.mirror.server;

import android.graphics.Rect;
import android.hardware.display.VirtualDisplay;
import android.os.IBinder;
import android.view.InputEvent;
import android.view.Surface;

import java.lang.reflect.Method;

/**
 * Reflection access to hidden framework APIs. The shell user may call these,
 * but they are not in the public SDK, so nothing here is checked at compile time.
 */
final class Hidden {
    private Hidden() {}

    static final class DisplayInfo {
        final int width;
        final int height;
        final int rotation;
        final int layerStack;

        DisplayInfo(int width, int height, int rotation, int layerStack) {
            this.width = width;
            this.height = height;
            this.rotation = rotation;
            this.layerStack = layerStack;
        }
    }

    static DisplayInfo getDisplayInfo(int displayId) throws ReflectiveOperationException {
        Class<?> cls = Class.forName("android.hardware.display.DisplayManagerGlobal");
        Object global = cls.getMethod("getInstance").invoke(null);
        Object info = cls.getMethod("getDisplayInfo", int.class).invoke(global, displayId);
        Class<?> ic = info.getClass();
        return new DisplayInfo(
                ic.getField("logicalWidth").getInt(info),
                ic.getField("logicalHeight").getInt(info),
                ic.getField("rotation").getInt(info),
                ic.getField("layerStack").getInt(info));
    }

    /** Handle that releases whichever mirroring mechanism was used. */
    interface Mirror {
        void release();
    }

    /**
     * Mirrors display 0 onto {@code surface}. Android 14+ exposes a static
     * {@code DisplayManager.createVirtualDisplay(..., displayIdToMirror, surface)};
     * older releases need the SurfaceControl display API.
     */
    static Mirror mirrorDisplay(String name, int width, int height, Surface surface, DisplayInfo info)
            throws ReflectiveOperationException {
        try {
            Method m = android.hardware.display.DisplayManager.class.getMethod("createVirtualDisplay",
                    String.class, int.class, int.class, int.class, Surface.class);
            VirtualDisplay vd = (VirtualDisplay) m.invoke(null, name, width, height, 0, surface);
            Ln.i("Mirroring with DisplayManager virtual display");
            return vd::release;
        } catch (NoSuchMethodException e) {
            return mirrorWithSurfaceControl(name, width, height, surface, info);
        }
    }

    private static Mirror mirrorWithSurfaceControl(String name, int width, int height, Surface surface,
            DisplayInfo info) throws ReflectiveOperationException {
        Class<?> sc = Class.forName("android.view.SurfaceControl");
        IBinder display = (IBinder) sc.getMethod("createDisplay", String.class, boolean.class)
                .invoke(null, name, false);
        sc.getMethod("openTransaction").invoke(null);
        try {
            sc.getMethod("setDisplaySurface", IBinder.class, Surface.class).invoke(null, display, surface);
            sc.getMethod("setDisplayProjection", IBinder.class, int.class, Rect.class, Rect.class)
                    .invoke(null, display, 0, new Rect(0, 0, info.width, info.height), new Rect(0, 0, width, height));
            sc.getMethod("setDisplayLayerStack", IBinder.class, int.class).invoke(null, display, info.layerStack);
        } finally {
            sc.getMethod("closeTransaction").invoke(null);
        }
        Ln.i("Mirroring with SurfaceControl display");
        return () -> {
            try {
                sc.getMethod("destroyDisplay", IBinder.class).invoke(null, display);
            } catch (ReflectiveOperationException e) {
                Ln.e("destroyDisplay failed", e);
            }
        };
    }

    private static Object inputManager;
    private static Method injectMethod;

    /** {@code InputManagerGlobal} on Android 14+, {@code InputManager} before. */
    static boolean injectInputEvent(InputEvent event) {
        try {
            if (injectMethod == null) {
                Class<?> cls;
                try {
                    cls = Class.forName("android.hardware.input.InputManagerGlobal");
                } catch (ClassNotFoundException e) {
                    cls = Class.forName("android.hardware.input.InputManager");
                }
                inputManager = cls.getMethod("getInstance").invoke(null);
                injectMethod = cls.getMethod("injectInputEvent", InputEvent.class, int.class);
            }
            // 0 = INJECT_INPUT_EVENT_MODE_ASYNC
            return (boolean) injectMethod.invoke(inputManager, event, 0);
        } catch (ReflectiveOperationException e) {
            Ln.e("injectInputEvent failed", e);
            return false;
        }
    }
}
