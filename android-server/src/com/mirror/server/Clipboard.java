package com.mirror.server;

import android.content.ClipData;
import android.content.IOnPrimaryClipChangedListener;
import android.os.IBinder;

import java.lang.reflect.Method;

/**
 * Phone clipboard through the hidden IClipboard service. Method signatures
 * changed across Android releases (extra attributionTag, userId, deviceId
 * parameters), so calls are matched by name and the trailing String/int
 * parameters are filled in by position.
 */
final class Clipboard {
    private static final String PACKAGE = "com.android.shell";

    interface Listener {
        void onTextChanged(String text);
    }

    private final Object service;
    private volatile String lastSetByDesktop;
    private volatile String lastSentToDesktop;

    private Clipboard(Object service) {
        this.service = service;
    }

    static Clipboard create() {
        try {
            IBinder binder = (IBinder) Class.forName("android.os.ServiceManager")
                    .getMethod("getService", String.class).invoke(null, "clipboard");
            Object service = Class.forName("android.content.IClipboard$Stub")
                    .getMethod("asInterface", IBinder.class).invoke(null, binder);
            return new Clipboard(service);
        } catch (ReflectiveOperationException e) {
            Ln.e("Clipboard unavailable", e);
            return null;
        }
    }

    String getText() {
        try {
            ClipData clip = (ClipData) call("getPrimaryClip");
            if (clip == null || clip.getItemCount() == 0) return null;
            CharSequence text = clip.getItemAt(0).getText();
            return text == null ? null : text.toString();
        } catch (ReflectiveOperationException e) {
            Ln.e("getPrimaryClip failed", e);
            return null;
        }
    }

    boolean setText(String text) {
        lastSetByDesktop = text;
        try {
            call("setPrimaryClip", ClipData.newPlainText("mirror", text));
            return true;
        } catch (ReflectiveOperationException e) {
            Ln.e("setPrimaryClip failed", e);
            return false;
        }
    }

    /** Reports text copied on the phone, but not text the desktop just set. */
    void listen(Listener listener) {
        IOnPrimaryClipChangedListener.Stub stub = new IOnPrimaryClipChangedListener.Stub() {
            @Override
            public void dispatchPrimaryClipChanged() {
                String text = getText();
                // Some vendors (Samsung) dispatch one copy twice; also skip
                // echoes of text the desktop just set.
                if (text == null || text.equals(lastSetByDesktop) || text.equals(lastSentToDesktop)) return;
                lastSentToDesktop = text;
                listener.onTextChanged(text);
            }
        };
        try {
            call("addPrimaryClipChangedListener", stub);
        } catch (ReflectiveOperationException e) {
            Ln.e("addPrimaryClipChangedListener failed", e);
        }
    }

    private Object call(String name, Object... leading) throws ReflectiveOperationException {
        for (Method m : service.getClass().getMethods()) {
            if (!m.getName().equals(name)) continue;
            Class<?>[] types = m.getParameterTypes();
            if (types.length < leading.length) continue;
            Object[] args = new Object[types.length];
            boolean ok = true;
            for (int i = 0; i < leading.length; i++) {
                if (!types[i].isInstance(leading[i])) ok = false;
                args[i] = leading[i];
            }
            // Trailing parameters: callingPackage, attributionTag, userId, deviceId.
            int strings = 0;
            for (int i = leading.length; i < types.length && ok; i++) {
                if (types[i] == String.class) {
                    args[i] = strings++ == 0 ? PACKAGE : null;
                } else if (types[i] == int.class) {
                    args[i] = 0; // USER_SYSTEM / DEVICE_ID_DEFAULT
                } else {
                    ok = false;
                }
            }
            if (ok) return m.invoke(service, args);
        }
        throw new NoSuchMethodException("IClipboard." + name);
    }
}
