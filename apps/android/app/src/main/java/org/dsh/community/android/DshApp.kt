package org.dsh.community.android

import android.app.Application
import android.util.Log

class DshApp : Application() {
    companion object {
        const val TAG = "DshAndroid"
        /** local HTTP port reserved for the future embedded official runtime */
        const val RUNTIME_PORT = 17890

        /**
         * Fail-loud gate. Flip only after a compatible Node 22.19+ Android
         * substrate is integrated and the Android Reality Gate passes.
         */
        const val RUNTIME_SUBSTRATE_READY = false
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "DshApp onCreate (runtimeSubstrateReady=$RUNTIME_SUBSTRATE_READY)")
    }
}
