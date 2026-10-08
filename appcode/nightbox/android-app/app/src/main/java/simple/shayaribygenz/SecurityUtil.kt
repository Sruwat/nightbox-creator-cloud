package simple.shayaribygenz

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.view.ViewGroup
import android.widget.Button

object SecurityUtil {

    private var currentDialog: Dialog? = null

    /**
     * Checks for active VPN and shows a blocking dialog if detected.
     * Call this in onResume() of your Activities.
     */
    fun checkVpn(activity: Activity) {
        if (isVpnActive(activity)) {
            showBlockingDialog(activity)
        } else {
            // Dismiss if it was showing and VPN is now off
            currentDialog?.dismiss()
            currentDialog = null
        }
    }

    private fun isVpnActive(context: Context): Boolean {
        val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val activeNetwork = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(activeNetwork) ?: return false
        return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    }

    private fun showBlockingDialog(activity: Activity) {
        if (currentDialog?.isShowing == true) return

        val dialog = Dialog(activity)
        dialog.setContentView(R.layout.dialog_security_alert)
        dialog.setCancelable(false)
        dialog.setCanceledOnTouchOutside(false)
        dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dialog.window?.setLayout(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        dialog.findViewById<Button>(R.id.btnExitApp).setOnClickListener {
            activity.finishAffinity()
        }

        dialog.findViewById<Button>(R.id.btnRestartApp).setOnClickListener {
            dialog.dismiss()
            activity.recreate() // Recreate will trigger onResume and check again
        }

        currentDialog = dialog
        dialog.show()
    }
}
