package com.mirror.server;

import android.app.Application;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.pm.ApplicationInfo;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;

/**
 * app_process starts without an ActivityThread or application. Some framework
 * calls (audio capture in particular) expect one, so a minimal one is set up
 * by reflection, identifying as the shell package.
 */
final class Workarounds {
    private static Object activityThread;
    private static Class<?> activityThreadClass;

    private Workarounds() {}

    static synchronized void apply() throws ReflectiveOperationException {
        if (activityThread != null) return;
        activityThreadClass = Class.forName("android.app.ActivityThread");
        Constructor<?> ctor = activityThreadClass.getDeclaredConstructor();
        ctor.setAccessible(true);
        activityThread = ctor.newInstance();
        Field current = activityThreadClass.getDeclaredField("sCurrentActivityThread");
        current.setAccessible(true);
        current.set(null, activityThread);

        // Android 13+: getSystemContext() reads the configuration through a
        // ConfigurationController that is normally created during app startup.
        try {
            Class<?> controllerClass = Class.forName("android.app.ConfigurationController");
            Class<?> internalClass = Class.forName("android.app.ActivityThreadInternal");
            Constructor<?> controllerCtor = controllerClass.getDeclaredConstructor(internalClass);
            controllerCtor.setAccessible(true);
            Field controller = activityThreadClass.getDeclaredField("mConfigurationController");
            controller.setAccessible(true);
            controller.set(activityThread, controllerCtor.newInstance(activityThread));
        } catch (ClassNotFoundException e) {
            // Before Android 13 there is no ConfigurationController.
        }

        // ActivityThread.mBoundApplication = new AppBindData { appInfo.packageName = shell }
        Class<?> bindDataClass = Class.forName("android.app.ActivityThread$AppBindData");
        Constructor<?> bindCtor = bindDataClass.getDeclaredConstructor();
        bindCtor.setAccessible(true);
        Object bindData = bindCtor.newInstance();
        ApplicationInfo info = new ApplicationInfo();
        info.packageName = FakeContext.PACKAGE_NAME;
        Field appInfo = bindDataClass.getDeclaredField("appInfo");
        appInfo.setAccessible(true);
        appInfo.set(bindData, info);
        Field bound = activityThreadClass.getDeclaredField("mBoundApplication");
        bound.setAccessible(true);
        bound.set(activityThread, bindData);

        // ActivityThread.mInitialApplication = Application wrapping the fake context
        Application app = new Application();
        Field base = ContextWrapper.class.getDeclaredField("mBase");
        base.setAccessible(true);
        base.set(app, FakeContext.get());
        Field initial = activityThreadClass.getDeclaredField("mInitialApplication");
        initial.setAccessible(true);
        initial.set(activityThread, app);
    }

    static Context systemContext() {
        try {
            if (activityThread == null) apply();
            return (Context) activityThreadClass.getDeclaredMethod("getSystemContext").invoke(activityThread);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("No system context", e);
        }
    }
}
