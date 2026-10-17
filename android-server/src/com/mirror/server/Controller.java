package com.mirror.server;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Reads control messages (docs/protocol.md) and injects input events. */
final class Controller {
    private static final int TYPE_TOUCH = 0;
    private static final int TYPE_KEY = 1;
    private static final int TYPE_TEXT = 2;
    private static final int TYPE_SCROLL = 3;
    private static final int TYPE_REQUEST_KEYFRAME = 4;
    private static final int TYPE_SET_CLIPBOARD = 5;
    private static final int TYPE_SET_SCREEN_POWER = 6;

    /** Device → desktop message types. */
    private static final int DEVICE_CLIPBOARD = 0;

    private static final int KEYCODE_PASTE = 279;

    private static final int MAX_POINTERS = 10;

    private final DataInputStream in;
    private final DataOutputStream out;
    private final ScreenEncoder encoder;
    private final Clipboard clipboard = Clipboard.create();
    private final KeyCharacterMap charMap = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD);

    // Active pointers, compacted: index i holds the i-th pointer currently down.
    private final long[] pointerIds = new long[MAX_POINTERS];
    private final MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[MAX_POINTERS];
    private final MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[MAX_POINTERS];
    private int pointerCount;
    private long downTime;
    /** Screen turned off from the desktop; restored when the session ends. */
    private volatile boolean screenOff;

    Controller(DataInputStream in, DataOutputStream out, ScreenEncoder encoder) {
        this.in = in;
        this.out = out;
        this.encoder = encoder;
        for (int i = 0; i < MAX_POINTERS; i++) {
            props[i] = new MotionEvent.PointerProperties();
            props[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
            coords[i] = new MotionEvent.PointerCoords();
            coords[i].size = 1;
        }
    }

    void run() throws IOException, ReflectiveOperationException {
        if (clipboard != null) clipboard.listen(this::sendClipboard);
        try {
            while (true) {
                int type = in.readUnsignedByte();
                switch (type) {
                    case TYPE_TOUCH:
                        touch(in.readUnsignedByte(), in.readInt() & 0xffffffffL, in.readFloat(), in.readFloat(), in.readFloat());
                        break;
                    case TYPE_KEY:
                        key(in.readUnsignedByte(), in.readInt(), in.readInt(), in.readInt());
                        break;
                    case TYPE_TEXT: {
                        byte[] bytes = new byte[in.readUnsignedShort()];
                        in.readFully(bytes);
                        text(new String(bytes, StandardCharsets.UTF_8));
                        break;
                    }
                    case TYPE_SCROLL:
                        scroll(in.readFloat(), in.readFloat(), in.readFloat(), in.readFloat());
                        break;
                    case TYPE_REQUEST_KEYFRAME:
                        encoder.requestKeyframe();
                        break;
                    case TYPE_SET_SCREEN_POWER:
                        screenOff = in.readUnsignedByte() == 0;
                        DisplayPower.set(!screenOff);
                        break;
                    case TYPE_SET_CLIPBOARD: {
                        boolean paste = in.readUnsignedByte() != 0;
                        byte[] bytes = new byte[in.readInt()];
                        in.readFully(bytes);
                        setClipboard(new String(bytes, StandardCharsets.UTF_8), paste);
                        break;
                    }
                    default:
                        throw new IOException("Unknown control message type " + type);
                }
            }
        } catch (EOFException e) {
            Ln.i("Control socket closed");
        } finally {
            // Never leave the phone with its screen off after the desktop goes away.
            if (screenOff) DisplayPower.set(true);
        }
    }

    private void sendClipboard(String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        try {
            synchronized (out) {
                out.writeByte(DEVICE_CLIPBOARD);
                out.writeInt(bytes.length);
                out.write(bytes);
                out.flush();
            }
        } catch (IOException e) {
            Ln.w("Could not send clipboard: " + e);
        }
    }

    private void setClipboard(String text, boolean paste) {
        if (clipboard == null || !clipboard.setText(text)) return;
        if (paste) {
            key(0, KEYCODE_PASTE, 0, 0);
            key(1, KEYCODE_PASTE, 0, 0);
        }
    }

    private void touch(int action, long pointerId, float nx, float ny, float pressure)
            throws ReflectiveOperationException {
        Hidden.DisplayInfo display = encoder.display();
        long now = SystemClock.uptimeMillis();

        int index = indexOf(pointerId);
        if (index < 0) {
            if (action != 0 || pointerCount == MAX_POINTERS) return;
            index = pointerCount++;
            pointerIds[index] = pointerId;
            props[index].id = index == 0 ? 0 : nextFreeId();
        }
        coords[index].x = clamp(nx) * display.width;
        coords[index].y = clamp(ny) * display.height;
        coords[index].pressure = action == 1 ? 0 : pressure;

        int motionAction;
        if (action == 0) {
            if (pointerCount == 1) {
                downTime = now;
                motionAction = MotionEvent.ACTION_DOWN;
            } else {
                motionAction = MotionEvent.ACTION_POINTER_DOWN | (index << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
            }
        } else if (action == 1) {
            motionAction = pointerCount == 1
                    ? MotionEvent.ACTION_UP
                    : MotionEvent.ACTION_POINTER_UP | (index << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
        } else {
            motionAction = MotionEvent.ACTION_MOVE;
        }

        MotionEvent event = MotionEvent.obtain(downTime, now, motionAction, pointerCount, props, coords,
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        Hidden.injectInputEvent(event);
        event.recycle();

        if (action == 1) removePointer(index);
    }

    private int indexOf(long pointerId) {
        for (int i = 0; i < pointerCount; i++) {
            if (pointerIds[i] == pointerId) return i;
        }
        return -1;
    }

    private int nextFreeId() {
        for (int id = 0; id < MAX_POINTERS; id++) {
            boolean used = false;
            for (int i = 0; i < pointerCount - 1; i++) {
                if (props[i].id == id) used = true;
            }
            if (!used) return id;
        }
        return 0;
    }

    private void removePointer(int index) {
        for (int i = index; i < pointerCount - 1; i++) {
            pointerIds[i] = pointerIds[i + 1];
            props[i].copyFrom(props[i + 1]);
            coords[i].copyFrom(coords[i + 1]);
        }
        pointerCount--;
    }

    private void key(int action, int keycode, int repeat, int metaState) {
        long now = SystemClock.uptimeMillis();
        KeyEvent event = new KeyEvent(now, now, action == 0 ? KeyEvent.ACTION_DOWN : KeyEvent.ACTION_UP,
                keycode, repeat, metaState, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD);
        Hidden.injectInputEvent(event);
    }

    private void text(String text) {
        KeyEvent[] events = charMap.getEvents(text.toCharArray());
        if (events == null) {
            // The virtual keyboard map cannot type these characters (Arabic,
            // CJK, emoji), so paste them instead.
            setClipboard(text, true);
            return;
        }
        for (KeyEvent e : events) {
            Hidden.injectInputEvent(e);
        }
    }

    private void scroll(float nx, float ny, float h, float v) {
        Hidden.DisplayInfo display = encoder.display();
        long now = SystemClock.uptimeMillis();
        MotionEvent.PointerProperties[] p = {new MotionEvent.PointerProperties()};
        p[0].toolType = MotionEvent.TOOL_TYPE_MOUSE;
        MotionEvent.PointerCoords[] c = {new MotionEvent.PointerCoords()};
        c[0].x = clamp(nx) * display.width;
        c[0].y = clamp(ny) * display.height;
        c[0].setAxisValue(MotionEvent.AXIS_HSCROLL, h);
        c[0].setAxisValue(MotionEvent.AXIS_VSCROLL, v);
        MotionEvent event = MotionEvent.obtain(now, now, MotionEvent.ACTION_SCROLL, 1, p, c,
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_MOUSE, 0);
        Hidden.injectInputEvent(event);
        event.recycle();
    }

    private static float clamp(float v) {
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }
}
