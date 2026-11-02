package io.ampbox.muxterm

import android.net.Uri
import android.content.ContentResolver
import android.content.Context
import android.provider.OpenableColumns
import android.webkit.CookieManager
import java.io.IOException
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

internal data class SatelliteNode(
    val id: String,
    val name: String,
    val state: String,
    val error: String = "",
)

internal data class SatelliteProject(
    val id: String,
    val name: String,
    val path: String,
    val nodeId: String,
)

internal data class SatelliteChat(
    val id: String,
    val title: String,
    val projectId: String,
    val nodeId: String,
    val harness: String,
    val state: String,
    val lastActivity: String,
    val updatedAt: String,
    val goal: String = "",
    val operator: Boolean = false,
)

internal data class SatelliteSnapshot(
    val nodes: List<SatelliteNode>,
    val projects: List<SatelliteProject>,
    val chats: List<SatelliteChat>,
)

internal data class SatelliteHistory(
    val transcript: ChatTranscript,
    val before: Long,
    val hasMore: Boolean,
)

internal data class SatelliteHarness(val name: String, val provider: String)
internal data class SatelliteModel(val id: String, val label: String, val efforts: List<String>)
internal data class SatelliteChatSettings(val model: String, val effort: String, val permission: String,
    val mode: String, val models: List<SatelliteModel>, val permissions: List<String>, val modes: List<String>)
internal data class SatelliteDownloadedAttachment(val file: File, val mimeType: String)

internal class SatelliteAuthRequired : IOException("Sign in to this muxterm server")

/** HTTP client for the server's existing SDK chat API. The WebView owns login;
 * native requests borrow its session cookie, like FleetWatchService does. */
internal class SatelliteApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(35, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS)
        .followRedirects(false)
        .build()

    suspend fun snapshot(server: String): SatelliteSnapshot = withContext(Dispatchers.IO) {
        val localName = Uri.parse(server).host ?: "This server"
        val nodes = mutableListOf(SatelliteNode("", localName, "connected"))
        val projects = mutableListOf<SatelliteProject>()
        val chats = mutableListOf<SatelliteChat>()

        readProjects(server, "", projects)
        readChats(server, "", chats)

        // The home server owns SSH settings. The phone only asks it to relay
        // chat API calls; it never needs SSH keys or a direct link to a node.
        runCatching { request(server, "/api/remotes") }.getOrNull()?.let { response ->
            val seen = mutableSetOf<String>()
            for (group in listOf("connected", "discovered", "errors")) {
                val rows = response.optJSONArray(group) ?: continue
                for (index in 0 until rows.length()) {
                    val row = rows.optJSONObject(index) ?: continue
                    val id = row.optString("id")
                    if (id.isBlank() || !seen.add(id)) continue
                    val state = row.optString("state", group)
                    val name = row.optString("name").ifBlank { id.substringAfter(':') }
                    nodes += SatelliteNode(id, name, state, row.optString("error"))
                    if (state == "connected") {
                        try {
                            readProjects(server, id, projects)
                            readChats(server, id, chats)
                        } catch (error: Exception) {
                            nodes[nodes.lastIndex] = SatelliteNode(id, name, "unreachable", error.message.orEmpty())
                        }
                    }
                }
            }
        }
        SatelliteSnapshot(nodes, projects, chats.sortedByDescending { it.updatedAt })
    }

    suspend fun harnesses(server: String, nodeId: String): List<SatelliteHarness> = withContext(Dispatchers.IO) {
        val rows = requestArray(server, route(nodeId, "/api/sdk-chat-start-options"))
        (0 until rows.length()).mapNotNull { index ->
            rows.optJSONObject(index)?.let { row ->
                val name = row.optString("harness")
                if (name.isBlank()) null else SatelliteHarness(name, row.optString("provider"))
            }
        }
    }

    suspend fun history(server: String, chat: SatelliteChat, before: Long? = null): SatelliteHistory = withContext(Dispatchers.IO) {
        val path = "/api/sdk-chats/${Uri.encode(chat.id)}/history?view=messages" +
            (before?.let { "&before=$it" } ?: "")
        val body = request(server, route(chat.nodeId, path))
        val events = body.optJSONArray("events") ?: JSONArray()
        SatelliteHistory(ChatPresentation.fromEvents(events), body.optLong("from"), body.optBoolean("hasMore"))
    }

    suspend fun createProject(server: String, nodeId: String, name: String): SatelliteProject = withContext(Dispatchers.IO) {
        val body = request(server, route(nodeId, "/api/sdk-projects"), "POST",
            JSONObject().put("name", name).put("managedFolder", true))
        projectFrom(body, nodeId)
    }

    suspend fun createChat(
        server: String, project: SatelliteProject, harness: SatelliteHarness, prompt: String,
    ): SatelliteChat = withContext(Dispatchers.IO) {
        val body = request(server, route(project.nodeId, "/api/sdk-chats"), "POST",
            JSONObject().put("workspaceId", project.id).put("harness", harness.name)
                .put("provider", harness.provider).put("prompt", prompt))
        chatFrom(body, project.nodeId)
    }

    suspend fun send(server: String, chat: SatelliteChat, text: String, steer: Boolean = false, attachments: List<String> = emptyList()) = withContext(Dispatchers.IO) {
        request(server, route(chat.nodeId, "/api/sdk-chats/${Uri.encode(chat.id)}"), "POST",
            JSONObject().put("id", UUID.randomUUID().toString()).put("kind", if (steer) "steer" else "user")
                .put("source", "android").put("content", text).put("attachments", JSONArray(attachments)))
        Unit
    }

    suspend fun stop(server: String, chat: SatelliteChat) = withContext(Dispatchers.IO) {
        request(server, route(chat.nodeId, "/api/sdk-chats/${Uri.encode(chat.id)}/interrupt"), "POST", JSONObject())
        Unit
    }

    suspend fun answerQuestion(server: String, chat: SatelliteChat, block: ChatBlock, answers: Map<String, String>) = withContext(Dispatchers.IO) {
        if (block.questionSource == "question.requested") {
            val body = JSONObject().put("answers", JSONObject(answers))
            request(server, route(chat.nodeId, "/api/sdk-chats/${Uri.encode(chat.id)}/questions/${Uri.encode(block.id)}"), "POST", body)
        } else {
            val content = block.questions.joinToString("\n\n") { "${it.prompt}\n${answers[it.id].orEmpty()}" }
            request(server, route(chat.nodeId, "/api/sdk-chats/${Uri.encode(chat.id)}"), "POST",
                JSONObject().put("id", UUID.randomUUID().toString())
                    .put("kind", if (chat.state == "working") "steer" else "user")
                    .put("source", "question").put("content", content))
        }
        Unit
    }

    suspend fun settings(server: String, chat: SatelliteChat): SatelliteChatSettings = withContext(Dispatchers.IO) {
        settingsFrom(request(server, route(chat.nodeId, "/api/sdk-chats/${Uri.encode(chat.id)}/settings")))
    }

    suspend fun updateSettings(server: String, chat: SatelliteChat, change: JSONObject): SatelliteChatSettings = withContext(Dispatchers.IO) {
        settingsFrom(request(server, route(chat.nodeId, "/api/sdk-chats/${Uri.encode(chat.id)}/settings"), "PATCH", change))
    }

    private fun settingsFrom(row: JSONObject): SatelliteChatSettings {
        fun strings(key: String): List<String> = row.optJSONArray(key)?.let { values ->
            (0 until values.length()).map { values.optString(it) }
        } ?: emptyList()
        val models = row.optJSONArray("models")?.let { values ->
            (0 until values.length()).mapNotNull { index -> values.optJSONObject(index)?.let { item ->
                val efforts = item.optJSONArray("efforts")
                SatelliteModel(item.optString("id"), item.optString("label"),
                    if (efforts == null) emptyList() else (0 until efforts.length()).map { efforts.optString(it) })
            } }
        } ?: emptyList()
        return SatelliteChatSettings(row.optString("model"), row.optString("effort"), row.optString("permission"),
            row.optString("mode"), models, strings("permissions"), strings("modes"))
    }

    suspend fun upload(server: String, chat: SatelliteChat, resolver: ContentResolver, uri: Uri): ChatAttachment = withContext(Dispatchers.IO) {
        val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }?.takeIf { it.isNotBlank() } ?: "attachment"
        val bytes = resolver.openInputStream(uri)?.use { stream ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (output.size() <= 20 * 1024 * 1024) {
                val count = stream.read(buffer)
                if (count < 0) break
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
            ?: throw IOException("Could not read the selected file")
        if (bytes.size > 20 * 1024 * 1024) throw IOException("Attachment exceeds the 20 MiB limit")
        val mediaType = (resolver.getType(uri) ?: "application/octet-stream").toMediaType()
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", name, bytes.toRequestBody(mediaType)).build()
        val path = route(chat.nodeId, "/api/sdk-chat-attachments")
        val builder = Request.Builder().url(server.trimEnd('/') + path).post(body)
            .header("Accept", "application/json").header("Sec-Fetch-Site", "same-origin")
            .header("X-Muxterm-Chat-Attachment", "1")
        CookieManager.getInstance().getCookie(server)?.let { builder.header("Cookie", it) }
        client.newCall(builder.build()).execute().use { response ->
            if (response.code == 401 || response.code in 300..399) throw SatelliteAuthRequired()
            val payload = response.body?.string().orEmpty()
            val result = runCatching { JSONObject(payload) }.getOrNull()
            if (!response.isSuccessful) throw IOException(result?.optString("reason")?.ifBlank { payload.take(200) } ?: payload.take(200))
            val id = result?.optString("id").orEmpty()
            if (id.isBlank()) throw IOException("Upload response lacked attachment details")
            ChatAttachment(id, name, result?.optString("kind").orEmpty())
        }
    }

    suspend fun download(server: String, chat: SatelliteChat, attachment: ChatAttachment, context: Context): SatelliteDownloadedAttachment = withContext(Dispatchers.IO) {
        val url = server.trimEnd('/') + route(chat.nodeId, "/api/sdk-chat-attachments/${Uri.encode(attachment.id)}")
        val builder = Request.Builder().url(url).header("Sec-Fetch-Site", "same-origin")
        CookieManager.getInstance().getCookie(server)?.let { builder.header("Cookie", it) }
        client.newCall(builder.build()).execute().use { response ->
            if (response.code == 401 || response.code in 300..399) throw SatelliteAuthRequired()
            if (!response.isSuccessful) throw IOException("Attachment could not be downloaded (${response.code})")
            val safeName = attachment.name.substringAfterLast('/').substringAfterLast('\\')
                .replace(Regex("[^A-Za-z0-9._-]"), "_").take(80).ifBlank { "attachment" }
            val directory = File(context.cacheDir, "chat-attachments").apply { mkdirs() }
            val file = File(directory, "${attachment.id.filter { it.isLetterOrDigit() }.take(32)}-$safeName")
            response.body?.byteStream()?.use { input -> file.outputStream().use { input.copyTo(it) } }
                ?: throw IOException("Attachment response was empty")
            SatelliteDownloadedAttachment(file, response.header("Content-Type") ?: "application/octet-stream")
        }
    }

    suspend fun branch(server: String, chat: SatelliteChat, inputId: String, mode: String,
        content: String = "", attachments: List<String> = emptyList()): SatelliteChat = withContext(Dispatchers.IO) {
        val pages = mutableListOf<List<JSONObject>>()
        var before: Long? = null
        do {
            val suffix = before?.let { "?before=$it" }.orEmpty()
            val page = request(server, route(chat.nodeId, "/api/sdk-chats/${Uri.encode(chat.id)}/history$suffix"))
            val events = page.optJSONArray("events") ?: JSONArray()
            pages.add(0, (0 until events.length()).mapNotNull { events.optJSONObject(it) })
            val from = page.optLong("from")
            if (!page.optBoolean("hasMore")) break
            if (before != null && from >= before) throw IOException("Could not locate this message in chat history")
            before = from
        } while (true)
        var turn = 0
        var selectedTurn = -1
        for (page in pages) for (event in page) {
            if (event.optString("type") == "input.accepted" && event.optString("inputId") == inputId)
                selectedTurn = turn
            if (event.optString("type") in listOf("turn.completed", "turn.cancelled", "error", "session.uncertain")) turn++
        }
        if (selectedTurn < 0) throw IOException("The selected message is no longer available")
        val body = request(server, route(chat.nodeId, "/api/sdk-chats/${Uri.encode(chat.id)}/branch"), "POST",
            JSONObject().put("mode", mode).put("turn", selectedTurn).put("inputId", inputId)
                .put("content", content).put("attachments", JSONArray(attachments)))
        chatFrom(body, chat.nodeId)
    }

    private fun readProjects(server: String, nodeId: String, out: MutableList<SatelliteProject>) {
        val rows = requestArray(server, route(nodeId, "/api/sdk-projects"))
        for (index in 0 until rows.length()) rows.optJSONObject(index)?.let { out += projectFrom(it, nodeId) }
    }

    private fun readChats(server: String, nodeId: String, out: MutableList<SatelliteChat>) {
        val rows = requestArray(server, route(nodeId, "/api/sdk-chats?archived=false"))
        for (index in 0 until rows.length()) rows.optJSONObject(index)?.let { out += chatFrom(it, nodeId) }
    }

    private fun projectFrom(row: JSONObject, nodeId: String) = SatelliteProject(
        row.optString("id"), row.optString("name"), row.optString("path"), nodeId)

    private fun chatFrom(row: JSONObject, nodeId: String) = SatelliteChat(
        row.optString("id"), row.optString("title"), row.optString("workspaceId"), nodeId,
        row.optString("harness"), row.optString("state"), row.optString("lastActivity"),
        row.optString("updatedAt", row.optString("createdAt")), row.optString("goal"), row.optBoolean("operator"))

    private fun route(nodeId: String, path: String): String =
        if (nodeId.isBlank()) path else "/api/remote-chat/${Uri.encode(nodeId)}$path"

    private fun requestArray(server: String, path: String): JSONArray = JSONArray(requestText(server, path))

    private fun request(server: String, path: String, method: String = "GET", body: JSONObject? = null): JSONObject =
        JSONObject(requestText(server, path, method, body))

    private fun requestText(server: String, path: String, method: String = "GET", body: JSONObject? = null): String {
        val url = server.trimEnd('/') + path
        // Remote chat routes admit a human browser request. This native,
        // cookie-authenticated client is an explicit human action surface too.
        val builder = Request.Builder().url(url).header("Accept", "application/json")
            .header("Sec-Fetch-Site", "same-origin")
        CookieManager.getInstance().getCookie(server)?.let { builder.header("Cookie", it) }
        if (method != "GET") builder.method(method, (body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            if (response.code == 401 || response.code in 300..399) throw SatelliteAuthRequired()
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IOException(text.trim().take(240).ifBlank { "Server returned ${response.code}" })
            return text
        }
    }
}
