package app.pedeai

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import android.Manifest
import android.os.Build
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

// Abre o painel do Pedeaí dentro do app. Links externos (WhatsApp, mapas) abrem no app correspondente.
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val permBluetooth = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    // Pede a permissão de Bluetooth (e localização, nas versões antigas do Android, para buscar impressoras)
    fun pedirBluetooth() {
        val perms = if (Build.VERSION.SDK_INT >= 31)
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        permBluetooth.launch(perms)
    }

    private val pickFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val uris = WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data)
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A tela não apaga enquanto o app estiver aberto, para os pedidos continuarem chegando
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this)
        setContentView(web)
        CookieManager.getInstance().setAcceptCookie(true)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                if (url.host == HOST) return false
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            // Links com target="_blank" (ex.: WhatsApp) abrem fora do app
            override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean {
                val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                val temp = WebView(this@MainActivity)
                temp.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView?, r: WebResourceRequest?): Boolean {
                        r?.url?.let { startActivity(Intent(Intent.ACTION_VIEW, it)) }
                        return true
                    }
                }
                transport.webView = temp
                resultMsg.sendToTarget()
                return true
            }

            // Permite escolher foto (logo e capa) pela galeria
            override fun onShowFileChooser(webView: WebView?, callback: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    pickFile.launch(params!!.createIntent())
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        web.addJavascriptInterface(PrinterBridge(this), "AndroidPrinter")
        web.loadUrl(SITE)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })
    }

    companion object {
        const val HOST = "pede-ai-9aun.onrender.com"
        const val SITE = "https://$HOST/painel"
    }
}
