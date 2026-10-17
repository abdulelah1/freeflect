package android.content;

/**
 * Compile-time stub of a hidden framework AIDL interface. It is not packaged
 * into the jar: at runtime the boot classpath's real class is used, which has
 * the same shape (a Binder Stub dispatching to dispatchPrimaryClipChanged).
 */
public interface IOnPrimaryClipChangedListener extends android.os.IInterface {
    void dispatchPrimaryClipChanged() throws android.os.RemoteException;

    abstract class Stub extends android.os.Binder implements IOnPrimaryClipChangedListener {
        public Stub() {}

        @Override
        public android.os.IBinder asBinder() {
            return this;
        }
    }
}
