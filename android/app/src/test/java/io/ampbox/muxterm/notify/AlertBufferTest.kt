package io.ampbox.muxterm.notify

import io.ampbox.muxterm.notify.TransitionDetector.Transition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** N4: coalescing, collapsing, and the two reasons to say nothing at all. */
class AlertBufferTest {

    private fun t(id: String, to: String, label: String = id, waitingFor: String = "") =
        Transition(
            row = LaneRow(
                sessionId = id, workspaceId = "w1", name = id,
                label = label, state = to, waitingFor = waitingFor,
            ),
            from = "working",
            to = to,
        )

    /** "everything is still in the state its transition claimed" */
    private fun stateFrom(vararg ts: Transition): (String) -> String? {
        val m = ts.associate { it.row.sessionId to it.to }
        return { m[it] }
    }

    @Test
    fun tenLanesFinishingAtOnceIsOneFlush() {
        val b = AlertBuffer()
        val all = (1..10).map { t("s$it", "done", label = "lane $it") }
        b.add(all)
        assertEquals(10, b.size)

        val plan = b.drain(stateFrom(*all.toTypedArray()), appForeground = false)
        assertEquals(0, plan.blocked.size)
        assertEquals(10, plan.finished.size)
        // One notification, not ten: the whole batch is described by one title.
        assertEquals("10 lanes are done", AlertText.finishedTitle(plan.finished))
        assertTrue(b.isEmpty)
    }

    @Test
    fun blockedAndFinishedSplitAcrossTheirTwoChannels() {
        val b = AlertBuffer()
        val ts = listOf(
            t("a", "blocked", label = "auth redirect", waitingFor = "permission prompt"),
            t("b", "done", label = "sidebar shadow"),
            t("c", "failed", label = "chat tail"),
        )
        b.add(ts)
        val plan = b.drain(stateFrom(*ts.toTypedArray()), appForeground = false)
        assertEquals(listOf("a"), plan.blocked.map { it.row.sessionId })
        assertEquals(listOf("b", "c"), plan.finished.map { it.row.sessionId })
    }

    @Test
    fun oneLaneFlippingInsideTheWindowIsOneEntry() {
        val b = AlertBuffer()
        // blocked -> working -> blocked, all inside one coalescing window.
        b.add(listOf(t("a", "blocked", waitingFor = "input needed")))
        b.add(listOf(t("a", "blocked", waitingFor = "dialog open")))
        assertEquals(1, b.size)

        val plan = b.drain({ "blocked" }, appForeground = false)
        assertEquals(1, plan.blocked.size)
        // The LATEST reason wins - the older one is already wrong.
        assertEquals("dialog open", plan.blocked[0].row.waitingFor)
    }

    @Test
    fun anEntryThatResolvedItselfIsDropped() {
        val b = AlertBuffer()
        b.add(listOf(t("a", "blocked"), t("b", "done")))
        // "a" answered itself and is working again by the time we flush.
        val plan = b.drain({ id -> if (id == "a") "working" else "done" }, appForeground = false)
        assertTrue(plan.blocked.isEmpty())
        assertEquals(listOf("b"), plan.finished.map { it.row.sessionId })
    }

    @Test
    fun aLaneThatVanishedBeforeTheFlushIsDropped() {
        val b = AlertBuffer()
        b.add(listOf(t("a", "done")))
        val plan = b.drain({ null }, appForeground = false)
        assertTrue(plan.isEmpty)
    }

    @Test
    fun nothingIsPostedWhileTheUserIsLookingAtTheApp() {
        val b = AlertBuffer()
        val ts = listOf(t("a", "blocked"), t("b", "done"))
        b.add(ts)
        val plan = b.drain(stateFrom(*ts.toTypedArray()), appForeground = true)
        assertTrue(plan.isEmpty)
        // Dropped, not deferred: they were watching it happen, and a buzz two
        // minutes later about something already seen is worse than silence.
        assertTrue(b.isEmpty)
    }

    @Test
    fun drainingAnEmptyBufferPostsNothing() {
        assertTrue(AlertBuffer().drain({ "blocked" }, appForeground = false).isEmpty)
    }

    @Test
    fun theFlushTimerIsArmedOnceAndClearedByTheFlush() {
        val b = AlertBuffer()
        b.add(listOf(t("a", "blocked")))
        b.flushArmed = true
        // A second batch inside the window must not re-arm; the window is
        // anchored to the first arrival so a steady drip cannot postpone it.
        b.add(listOf(t("b", "done")))
        assertTrue(b.flushArmed)
        b.drain({ id -> if (id == "a") "blocked" else "done" }, appForeground = false)
        assertTrue(!b.flushArmed)
    }
}

/** The strings that actually appear on the phone. */
class AlertTextTest {

    private fun t(id: String, to: String, label: String, waitingFor: String = "") =
        Transition(
            row = LaneRow(
                sessionId = id, workspaceId = "w1", name = "session $id",
                label = label, state = to, waitingFor = waitingFor,
            ),
            from = "working",
            to = to,
        )

    @Test
    fun oneBlockedLaneNamesItAndSaysWhatItWants() {
        val one = listOf(t("a", "blocked", "auth redirect", "permission prompt"))
        assertEquals("auth redirect needs you", AlertText.blockedTitle(one))
        assertEquals("permission prompt", AlertText.blockedBody(one))
    }

    @Test
    fun aBlockedLaneWithNoStatedReasonStillReads() {
        // waitingFor is "empty unless blocked" by producer convention, not by
        // enforcement, so a blocked row with nothing to say must not render "".
        val one = listOf(t("a", "blocked", "auth redirect"))
        assertEquals("waiting for you", AlertText.blockedBody(one))
    }

    @Test
    fun severalBlockedLanesAreCountedAndListed() {
        val many = listOf(
            t("a", "blocked", "auth redirect", "permission prompt"),
            t("b", "blocked", "sidebar shadow", "input needed"),
        )
        assertEquals("2 lanes need you", AlertText.blockedTitle(many))
        assertEquals("auth redirect, sidebar shadow", AlertText.blockedBody(many))
        assertEquals("auth redirect - permission prompt", AlertText.line(many[0]))
    }

    @Test
    fun doneAndFailedReadDifferently() {
        assertEquals("chat tail is done", AlertText.finishedTitle(listOf(t("a", "done", "chat tail"))))
        assertEquals("chat tail failed", AlertText.finishedTitle(listOf(t("a", "failed", "chat tail"))))
    }

    @Test
    fun aMixedBatchDoesNotClaimTheyAllSucceeded() {
        val mixed = listOf(t("a", "done", "one"), t("b", "failed", "two"))
        assertEquals("2 lanes finished", AlertText.finishedTitle(mixed))
        assertEquals("3 lanes failed", AlertText.finishedTitle(listOf(t("a", "failed", "one"), t("b", "failed", "two"), t("c", "failed", "three"))))
        assertEquals("2 lanes are done", AlertText.finishedTitle(listOf(t("a", "done", "one"), t("b", "done", "two"))))
    }

    @Test
    fun anUnlabelledLaneFallsBackToItsName() {
        assertEquals("session a is done", AlertText.finishedTitle(listOf(t("a", "done", ""))))
    }
}
