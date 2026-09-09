package io.ampbox.muxterm.car

import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator
import io.ampbox.muxterm.BuildConfig
import io.ampbox.muxterm.R

/**
 * Entry point Android Auto binds to. All display logic lives in
 * [MuxtermSession] / [FleetScreen]; this class only answers "who may connect"
 * and "give me a session".
 */
class MuxtermCarAppService : CarAppService() {

    override fun createHostValidator(): HostValidator =
        if (BuildConfig.DEBUG) {
            // ALLOW_ALL is fine for a sideloaded debug build talking to a
            // debug head unit / Desktop Head Unit, and nothing else - it
            // would be an unacceptable host check in anything released.
            HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
        } else {
            HostValidator.Builder(applicationContext)
                .addAllowedHosts(R.array.hosts_allowlist_sample)
                .build()
        }

    override fun onCreateSession(): Session = MuxtermSession()
}
