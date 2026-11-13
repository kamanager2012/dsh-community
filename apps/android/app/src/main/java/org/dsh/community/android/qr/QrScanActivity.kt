package org.dsh.community.android.qr

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import org.dsh.community.android.R
import org.dsh.community.android.transport.PairingQrParser
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class QrScanActivity : AppCompatActivity() {
    companion object {
        const val EXTRA_QR_PAYLOAD = "extra_qr_payload"
    }

    private lateinit var previewView: PreviewView
    private lateinit var tvHint: TextView
    private lateinit var btnTorch: Button
    private lateinit var btnCancel: Button

    private val analysisExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "dsh-qr-analyzer").apply { isDaemon = true }
    }
    private val finishedScan = AtomicBoolean(false)
    private var cameraProvider: ProcessCameraProvider? = null
    private var boundCamera: Camera? = null
    private var torchEnabled = false
    private var lastInvalidFeedbackMs = 0L

    private val requestCameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            startCamera()
        } else {
            tvHint.text = "Camera permission is required to scan pairing QR codes. You can paste a dsh-remote://pair link instead."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_qr_scan)

        previewView = findViewById(R.id.preview_view)
        tvHint = findViewById(R.id.tv_scan_hint)
        btnTorch = findViewById(R.id.btn_scan_torch)
        btnCancel = findViewById(R.id.btn_scan_cancel)

        btnCancel.setOnClickListener {
            setResult(RESULT_CANCELED)
            finish()
        }
        btnTorch.setOnClickListener {
            val cam = boundCamera ?: return@setOnClickListener
            if (cam.cameraInfo.hasFlashUnit()) {
                torchEnabled = !torchEnabled
                cam.cameraControl.enableTorch(torchEnabled)
                btnTorch.text = if (torchEnabled) "Torch On" else "Torch"
            }
        }

        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            tvHint.text = "No camera detected on this device. Go back and paste the pairing URI or JSON."
            return
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            requestCameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onDestroy() {
        cameraProvider?.unbindAll()
        analysisExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener(
            {
                try {
                    val provider = future.get()
                    cameraProvider = provider
                    val preview = Preview.Builder().build().apply {
                        setSurfaceProvider(previewView.surfaceProvider)
                    }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                        .apply {
                            setAnalyzer(analysisExecutor) { image -> analyzeFrame(image) }
                        }
                    provider.unbindAll()
                    val cam = provider.bindToLifecycle(
                        this,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        analysis,
                    )
                    boundCamera = cam
                    btnTorch.visibility = if (cam.cameraInfo.hasFlashUnit()) View.VISIBLE else View.GONE
                } catch (t: Throwable) {
                    tvHint.text = "Unable to start camera: ${t.message ?: t.javaClass.simpleName}"
                }
            },
            ContextCompat.getMainExecutor(this),
        )
    }

    private fun analyzeFrame(image: ImageProxy) {
        try {
            if (finishedScan.get()) return
            if (image.format != ImageFormat.YUV_420_888 &&
                image.format != ImageFormat.YUV_422_888 &&
                image.format != ImageFormat.YUV_444_888
            ) {
                return
            }
            val yPlane = image.planes.firstOrNull() ?: return
            val yBytes = QrImageDecoder.extractYPlaneBytes(
                buffer = yPlane.buffer,
                width = image.width,
                height = image.height,
                rowStride = yPlane.rowStride,
                pixelStride = yPlane.pixelStride,
            )
            val decoded = QrImageDecoder.decodeYPlane(
                yBytes = yBytes,
                width = image.width,
                height = image.height,
            ) ?: return

            try {
                PairingQrParser.parse(decoded)
            } catch (_: Throwable) {
                val now = System.currentTimeMillis()
                if (now - lastInvalidFeedbackMs > 1_200L) {
                    lastInvalidFeedbackMs = now
                    runOnUiThread {
                        if (!finishedScan.get()) {
                            tvHint.text = "QR detected, but not a valid DSH pairing code — keep aiming"
                        }
                    }
                }
                return
            }

            if (finishedScan.compareAndSet(false, true)) {
                runOnUiThread {
                    val out = Intent().putExtra(EXTRA_QR_PAYLOAD, decoded)
                    setResult(RESULT_OK, out)
                    finish()
                }
            }
        } finally {
            image.close()
        }
    }
}
