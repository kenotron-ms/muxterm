package io.ampbox.muxterm.notify

import org.json.JSONArray
import org.json.JSONObject

/**
 * One row of the daemon's `session-state` push, reduced to the fields this
 * feature actually reads.
 *
 * Deliberately NOT the same class as [io.ampbox.muxterm.car.FleetRepository.SessionRow].
 * That one belongs to the Android Auto screen and is being changed by other
 * work; sharing it would couple two features that have nothing in common but a
 * wire format, and would put two lanes in one file. See
 * docs/design/android-notifications.md, "Why a second row type".
 *
 * Field names are the wire names from internal/sessiond/sessionstate.go:
 * `sessionId`, `workspaceId`, `name`, `label`, `state`, `waitingFor` - camelCase,
 * and every optional one is `omitempty`, so it can be ABSENT rather than empty.
 */
data class LaneRow(
    val sessionId: String,
    val workspaceId: String,
    val name: String,
    val label: String,
    val state: String,
    val waitingFor: String,
) {
    /** What a notification calls this lane: the human label if there is one. */
    val displayName: String
        get() = label.ifBlank { name }.ifBlank { sessionId }

    companion object {
        /**
         * Parse a whole `session-state` message body.
         *
         * ABSENT MEANS EMPTY: `sessions` is an omitempty field, so a fleet that
         * just went to zero arrives as a bare `{"type":"session-state"}` with
         * no `sessions` key. Returning the empty list (rather than null, or
         * "no change") is what lets the detector forget rows that are gone.
         */
        fun parseAll(message: JSONObject): List<LaneRow> {
            val arr: JSONArray = message.optJSONArray("sessions") ?: return emptyList()
            val out = ArrayList<LaneRow>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val row = parseRow(o) ?: continue
                out += row
            }
            return out
        }

        /** Null for a row with no usable identity - it could never be tracked. */
        fun parseRow(o: JSONObject): LaneRow? {
            val id = o.optString("sessionId")
            if (id.isNullOrBlank()) return null
            return LaneRow(
                sessionId = id,
                workspaceId = o.optString("workspaceId"),
                name = o.optString("name"),
                label = o.optString("label"),
                state = o.optString("state"),
                waitingFor = o.optString("waitingFor"),
            )
        }
    }
}
