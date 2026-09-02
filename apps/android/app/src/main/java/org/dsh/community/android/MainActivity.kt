package org.dsh.community.android

import android.app.Activity
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * Thin WebView shell over the official runtime's local web UI.
 *
 * Target architecture: an embedded compatible Node runtime serves the official
 * DeepSeek Harness web UI on http://127.0.0.1:[DshApp.RUNTIME_PORT].
 * The runtime substrate is currently gated off; this shell deliberately does
 * NOT reimplement any harness logic.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webview)

        configureWebView()
        if (DshApp.RUNTIME_SUBSTRATE_READY) {
            startRuntime()
            webView.loadUrl("http://127.0.0.1:${DshApp.RUNTIME_PORT}/")
        } else {
            showRuntimeBlocked()
        }
    }

    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // local server is plain HTTP; allow from the app's own origin only
                safeBrowsingEnabled = true
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val host = request.url.host
                val port = request.url.port
                val ok = host == "127.0.0.1" && port == DshApp.RUNTIME_PORT
                if (!ok) {
                    Toast.makeText(this@MainActivity, "External URL blocked", Toast.LENGTH_SHORT).show()
                }
                return !ok
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                if (url?.startsWith("http://127.0.0.1:${DshApp.RUNTIME_PORT}") != true) {
                    // runtime not up yet — show a lightweight waiting page
                    view?.loadDataWithBaseURL(
                        null,
                        "<html><body style='font-family:sans-serif;padding:2em'>" +
                            "Waiting for harness runtime…" +
                            "</body></html>",
                        "text/html", "utf-8", null
                    )
                }
            }
        }
    }

    private fun startRuntime() {
        RuntimeService.start(this)
    }

    private fun showRuntimeBlocked() {
        webView.loadDataWithBaseURL(
            null,
            "<html><body style='font-family:sans-serif;padding:2em'>" +
                "<h2>Android runtime not verified</h2>" +
                "<p>This first-party endpoint is active source, but the embedded " +
                "Node 22.19+ runtime substrate has not passed its Reality Gate yet.</p>" +
                "</body></html>",
            "text/html",
            "utf-8",
            null
        )
    }

    override fun onDestroy() {
        // keep the runtime service alive in background; it self-stops on idle
        super.onDestroy()
    }
}
