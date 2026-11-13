package org.dsh.community.android

import android.app.Application
import android.util.Log

/**
 * DSH Community Android endpoint — pure thin Remote Client (R5).
 * Carries zero embedded Node runtime and zero official DSH runtime packages.
 */
class DshApp : Application() {
    companion object {
        const val TAG = "DshRemoteAndroid"
        const val REMOTE_CLIENT_MODE = true
        const val EMBEDDED_NODE_RUNTIME = false
        /** Remains false (fail-closed) until real-device R6 Remote Acceptance passes. */
        const val REAL_DEVICE_ACCEPTANCE_READY = false
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(
            TAG,
            "Initialized DSH Remote Client (remoteOnly=$REMOTE_CLIENT_MODE, embeddedNode=$EMBEDDED_NODE_RUNTIME, releaseReady=$REAL_DEVICE_ACCEPTANCE_READY)",
        )
    }
}
