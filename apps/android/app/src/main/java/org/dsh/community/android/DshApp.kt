package org.dsh.community.android

import android.app.Application
import android.util.Log

class DshApp : Application() {
    companion object {
        const val TAG = "DshAndroid"
        /** local HTTP port served by the embedded official runtime */
        const val RUNTIME_PORT = 17890
    }

    override fun onCreate() {
        super.onCreate()
        // nodejs-mobile starts in RuntimeService (kept alive while app is used)
        Log.i(TAG, "DshApp onCreate")
    }
}
