package io.ampbox.muxterm.car

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.model.Action
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.SectionedItemList
import androidx.car.app.model.Template
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/**
 * The one and only car screen: no drill-down, no navigation stack. It shows
 * two grouped lists - sessions blocked on the driver, and sessions still
 * working - and nothing else ever appears (done/failed/stopped sessions are
 * filtered out by [FleetRepository] never emitting them as anything but
 * absent).
 */
class FleetScreen(carContext: CarContext) : Screen(carContext), DefaultLifecycleObserver {

    // ListTemplate is not a screen the host will let a 5-template task end
    // on, and pushing a new Screen per update would burn through that budget
    // in seconds. invalidate() re-requests a template for THIS screen
    // instead of pushing a new one - the only refresh mechanism that works
    // for a one-screen app like this.
    private val onFleetChanged: () -> Unit = { invalidate() }

    init {
        lifecycle.addObserver(this)
    }

    override fun onCreate(owner: LifecycleOwner) {
        FleetRepository.addListener(onFleetChanged)
    }

    override fun onDestroy(owner: LifecycleOwner) {
        FleetRepository.removeListener(onFleetChanged)
    }

    override fun onGetTemplate(): Template {
        // Never dialed successfully yet, and no failure recorded either: this
        // is the first-second startup window, not an outage. A loading
        // ListTemplate must carry no lists at all.
        if (!FleetRepository.hasSnapshot() && !FleetRepository.everFailedToConnect()) {
            return ListTemplate.Builder()
                .setLoading(true)
                .setTitle("muxterm")
                .setHeaderAction(Action.APP_ICON)
                .build()
        }

        if (!FleetRepository.hasSnapshot()) {
            return MessageTemplate.Builder("Can't reach muxterm")
                .setTitle("muxterm")
                .setHeaderAction(Action.APP_ICON)
                .build()
        }

        val sessions = FleetRepository.currentSessions()
        val blocked = sessions.filter { it.state == "blocked" }
        val working = sessions.filter { it.state == "working" }

        if (blocked.isEmpty() && working.isEmpty()) {
            // Both groups empty: addSectionedList() throws on an empty
            // ItemList, so a sectioned ListTemplate simply isn't an option
            // here. This is a genuinely empty fleet, not an outage.
            return MessageTemplate.Builder("Nothing needs you.")
                .setTitle("muxterm")
                .setHeaderAction(Action.APP_ICON)
                .build()
        }

        val limit = carContext.getCarService(ConstraintManager::class.java)
            .getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
            .coerceAtLeast(2)

        // Allocation: blocked sessions (things actively waiting on the
        // driver) get first claim on the row budget, up to limit - 1 rows.
        // Working sessions get whatever is left, but never zero rows while
        // any are running, so "work is happening" never goes silent.
        val blockedRows = buildRows(blocked, (limit - 1).coerceAtLeast(0)) { it.waitingFor }
        val workingBudget = (limit - blockedRows.size).let { remaining ->
            if (working.isNotEmpty()) remaining.coerceAtLeast(1) else remaining.coerceAtLeast(0)
        }
        val workingRows = buildRows(working, workingBudget) { it.doing }

        val builder = ListTemplate.Builder()
            .setTitle("muxterm")
            .setHeaderAction(Action.APP_ICON)

        if (blockedRows.isNotEmpty()) {
            val items = ItemList.Builder()
            blockedRows.forEach { items.addItem(it) }
            builder.addSectionedList(SectionedItemList.create(items.build(), "NEEDS MY INPUT"))
        }
        if (workingRows.isNotEmpty()) {
            val items = ItemList.Builder()
            workingRows.forEach { items.addItem(it) }
            builder.addSectionedList(SectionedItemList.create(items.build(), "ONGOING"))
        }

        return builder.build()
    }

    /**
     * Turns up to [budget] sessions into rows, replacing the last one with a
     * "+N more" row when the group is truncated. Priority between the two
     * groups is carried by section order and header text ("NEEDS MY INPUT"
     * literally at the top) and by position within a section - never by row
     * colour: the host chooses its own day/night palette, may fall back to
     * defaults when a custom CarColor fails contrast, and only a row's
     * secondary line accepts colour at all, so colour cannot carry priority.
     */
    private fun buildRows(
        all: List<FleetRepository.SessionRow>,
        budget: Int,
        detail: (FleetRepository.SessionRow) -> String?,
    ): List<Row> {
        if (all.isEmpty() || budget <= 0) return emptyList()
        if (all.size <= budget) return all.map { rowFor(it, detail(it)) }

        val shown = all.take((budget - 1).coerceAtLeast(0))
        val more = all.size - shown.size
        return shown.map { rowFor(it, detail(it)) } + Row.Builder().setTitle("+$more more").build()
    }

    private fun rowFor(session: FleetRepository.SessionRow, detail: String?): Row =
        Row.Builder()
            .setTitle(session.displayName)
            .addText(detail?.takeIf { it.isNotBlank() } ?: "\u2026")
            .build()
}
