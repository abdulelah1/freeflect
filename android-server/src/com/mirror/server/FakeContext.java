package com.mirror.server;

import android.annotation.TargetApi;
import android.content.AttributionSource;
import android.content.Context;
import android.content.ContextWrapper;
import android.os.Process;

/**
 * A Context that identifies as the shell package. Audio capture checks the
 * caller's package and attribution; the server runs as the shell user but has
 * no real application context, so this one stands in for it.
 */
final class FakeContext extends ContextWrapper {
    static final String PACKAGE_NAME = "com.android.shell";

    private static FakeContext instance;

    static synchronized FakeContext get() {
        if (instance == null) instance = new FakeContext(Workarounds.systemContext());
        return instance;
    }

    private FakeContext(Context base) {
        super(base);
    }

    @Override
    public String getPackageName() {
        return PACKAGE_NAME;
    }

    @Override
    public String getOpPackageName() {
        return PACKAGE_NAME;
    }

    @TargetApi(31)
    @Override
    public AttributionSource getAttributionSource() {
        return new AttributionSource.Builder(Process.SHELL_UID).setPackageName(PACKAGE_NAME).build();
    }

    @Override
    public int getDeviceId() {
        return 0; // Context.DEVICE_ID_DEFAULT (API 34)
    }

    @Override
    public Context getApplicationContext() {
        return this;
    }
}
