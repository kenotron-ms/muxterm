package io.ampbox.muxterm

import android.content.Intent
import android.content.ActivityNotFoundException
import android.app.Activity
import android.os.Bundle
import android.speech.RecognizerIntent
import android.graphics.BitmapFactory
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

// Light chrome tokens from web/src/lib/theme.ts and the chat's 14% user tint.
private val paper = Color(0xFFF2F2F7)
private val raised = Color(0xFFE8E8ED)
private val ink = Color(0xFF1C1C1E)
private val secondary = Color(0xFF5C5C5F)
private val line = Color(0xFFC6C6C8)
private val blue = Color(0xFF005BB5)
private val userTint = Color(0xFFD0DDEE)
private val green = Color(0xFF1B9C66)
private val amber = Color(0xFFB87927)

/** The Android satellite's primary surface. The full web workspace remains
 * available for features the native client does not yet present. */
class SatelliteActivity : ComponentActivity() {
    private var resumeToken by mutableIntStateOf(0)
    private var sharedText by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = android.graphics.Color.rgb(242, 242, 247)
        window.navigationBarColor = android.graphics.Color.rgb(242, 242, 247)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        receiveShare(intent)
        setContent {
            MaterialTheme(
                colorScheme = lightColorScheme(
                    primary = blue, onPrimary = Color.White, surface = paper,
                    onSurface = ink, background = paper, onBackground = ink,
                    outline = line,
                ),
            ) {
                SatelliteScreen(
                    resumeToken = resumeToken,
                    sharedText = sharedText,
                    clearShare = { sharedText = null },
                    openWorkspace = { startActivity(Intent(this, MainActivity::class.java)) },
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        resumeToken++
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        receiveShare(intent)
    }

    private fun receiveShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND || intent.type != "text/plain") return
        sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()?.takeIf { it.isNotEmpty() }
    }
}

@Composable
private fun SatelliteScreen(
    resumeToken: Int,
    sharedText: String?,
    clearShare: () -> Unit,
    openWorkspace: () -> Unit,
) {
    val context = LocalContext.current
    val api = remember { SatelliteApi() }
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(UrlResolver.resolveUrl(context)) }
    var snapshot by remember { mutableStateOf<SatelliteSnapshot?>(null) }
    var selectedChat by remember { mutableStateOf<SatelliteChat?>(null) }
    var history by remember { mutableStateOf<SatelliteHistory?>(null) }
    var olderBlocks by remember { mutableStateOf<List<ChatBlock>>(emptyList()) }
    var olderCursor by remember { mutableStateOf<Long?>(null) }
    var olderHasMore by remember { mutableStateOf<Boolean?>(null) }
    var loading by remember { mutableStateOf(true) }
    var authRequired by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }
    var attachments by remember { mutableStateOf<List<ChatAttachment>>(emptyList()) }
    var uploading by remember { mutableStateOf(false) }
    var answeringQuestion by remember { mutableStateOf("") }
    var chatSettings by remember { mutableStateOf<SatelliteChatSettings?>(null) }
    var showChatSettings by remember { mutableStateOf(false) }
    var editingBlock by remember { mutableStateOf<ChatBlock?>(null) }
    var editDraft by remember { mutableStateOf("") }
    var showServer by remember { mutableStateOf(false) }
    var showNewProject by remember { mutableStateOf(false) }
    var newChatProject by remember { mutableStateOf<SatelliteProject?>(null) }
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    val attachmentPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        val chat = selectedChat
        if (uri != null && chat != null) scope.launch {
            uploading = true
            try { attachments = attachments + api.upload(server, chat, context.contentResolver, uri) }
            catch (failure: Exception) { error = failure.message ?: "Attachment could not be uploaded" }
            finally { uploading = false }
        }
    }
    val speechPicker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val spoken = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty()
            if (spoken.isNotBlank()) draft = listOf(draft.trim(), spoken).filter { it.isNotBlank() }.joinToString(" ")
        }
    }

    LaunchedEffect(sharedText) {
        if (sharedText != null && selectedChat != null) draft = sharedText
    }

    fun discardShare() {
        if (draft == sharedText) draft = ""
        clearShare()
    }

    suspend fun refresh() {
        try {
            val fresh = api.snapshot(server)
            snapshot = fresh
            selectedChat?.let { selected ->
                selectedChat = fresh.chats.firstOrNull { it.id == selected.id && it.nodeId == selected.nodeId } ?: selected
            }
            authRequired = false
            error = ""
        } catch (_: SatelliteAuthRequired) {
            authRequired = true
            snapshot = null
            error = ""
        } catch (failure: Exception) {
            error = failure.message ?: "Could not reach this server"
        } finally {
            loading = false
        }
    }

    LaunchedEffect(server, resumeToken) {
        loading = snapshot == null
        while (isActive) {
            refresh()
            delay(12_000)
        }
    }

    LaunchedEffect(server, selectedChat?.id, selectedChat?.nodeId) {
        history = null
        olderBlocks = emptyList()
        olderCursor = null
        olderHasMore = null
        val chat = selectedChat ?: return@LaunchedEffect
        while (isActive) {
            try {
                history = api.history(server, chat)
                error = ""
            } catch (failure: Exception) {
                error = failure.message ?: "Could not load this chat"
            }
            delay(3_000)
        }
    }

    LaunchedEffect(server, selectedChat?.id, selectedChat?.nodeId) {
        chatSettings = null
        selectedChat?.let { chat -> runCatching { api.settings(server, chat) }.onSuccess { chatSettings = it } }
    }

    Surface(color = paper, modifier = Modifier.fillMaxSize()) {
        Column {
            if (selectedChat == null) {
                Header(server, snapshot?.nodes?.firstOrNull()?.state == "connected", { showServer = true }, openWorkspace)
                if (sharedText != null) {
                    ShareBanner(sharedText, ::discardShare)
                }
                Row(
                    modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Projects", fontSize = 21.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    TextButton(onClick = { showNewProject = true }, enabled = !authRequired) { Text("New project") }
                }
                when {
                    authRequired -> CenterState("Sign in to see your projects and chats.", "Sign in", openWorkspace)
                    loading && snapshot == null -> CenterProgress()
                    snapshot == null -> CenterState(error.ifBlank { "Server unavailable" }, "Server settings") { showServer = true }
                    else -> {
                        if (error.isNotBlank()) ErrorLine(error)
                        ProjectList(snapshot!!, expanded, sharedText != null,
                            onProjectChat = { newChatProject = it },
                            onChat = {
                                selectedChat = it
                                if (sharedText != null) draft = sharedText
                            })
                    }
                }
            } else {
                val chat = selectedChat!!
                ChatHeader(chat, snapshot?.nodes?.firstOrNull { it.id == chat.nodeId }?.name ?: "This server",
                    onBack = { selectedChat = null; draft = ""; attachments = emptyList() }, openWorkspace)
                if (sharedText != null) ShareBanner(sharedText, ::discardShare)
                if (error.isNotBlank()) ErrorLine(error)
                if (chat.state == "blocked" || chat.state == "failed")
                    ErrorLine(if (chat.state == "blocked") "This chat is blocked and needs your attention."
                        else "The last turn failed. Review the transcript before continuing.")
                val blocks = olderBlocks + (history?.transcript?.blocks ?: emptyList())
                val working = if (history?.transcript?.blocks?.isNotEmpty() == true) history?.transcript?.running == true
                    else chat.state == "working" || chat.state == "starting"
                LazyColumn(modifier = Modifier.weight(1f), reverseLayout = false) {
                    if (olderHasMore ?: (history?.hasMore == true)) item {
                        TextButton(onClick = {
                            val before = olderCursor ?: history?.before ?: return@TextButton
                            scope.launch {
                                try {
                                    val page = api.history(server, chat, before)
                                    val shift = (olderBlocks.minOfOrNull { it.turn } ?: 0) -
                                        (page.transcript.blocks.maxOfOrNull { it.turn } ?: 0) - 1
                                    olderBlocks = page.transcript.blocks.map { it.copy(turn = it.turn + shift) } + olderBlocks
                                    olderCursor = page.before
                                    olderHasMore = page.hasMore
                                } catch (failure: Exception) { error = failure.message.orEmpty() }
                            }
                        }, modifier = Modifier.fillMaxWidth()) { Text("Load earlier messages") }
                    }
                    itemsIndexed(blocks) { index, block -> ChatBlockRow(block, blocks, index, working,
                        answeringQuestion == block.id && block.id.isNotBlank(),
                        canBranch = !working && chat.state == "ready" && chat.goal.isBlank() && !chat.operator,
                        onEdit = { selected -> editingBlock = selected; editDraft = selected.text },
                        onFork = { inputId -> scope.launch {
                            busy = true
                            try { selectedChat = api.branch(server, chat, inputId, "fork"); refresh() }
                            catch (failure: Exception) { error = failure.message ?: "Could not fork chat" }
                            finally { busy = false }
                        } },
                        loadImage = { attachment ->
                            val downloaded = api.download(server, chat, attachment, context)
                            withContext(Dispatchers.IO) {
                                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                                BitmapFactory.decodeFile(downloaded.file.path, bounds)
                                var sample = 1
                                while (bounds.outWidth / sample > 1024 || bounds.outHeight / sample > 1024) sample *= 2
                                BitmapFactory.decodeFile(downloaded.file.path,
                                    BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
                            }
                        },
                        onAttachment = { attachment -> scope.launch {
                            try {
                                val downloaded = api.download(server, chat, attachment, context)
                                val uri = FileProvider.getUriForFile(context, "${context.packageName}.chatfiles", downloaded.file)
                                val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, downloaded.mimeType)
                                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                try { context.startActivity(view) }
                                catch (_: ActivityNotFoundException) {
                                    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND)
                                        .setType(downloaded.mimeType).putExtra(Intent.EXTRA_STREAM, uri)
                                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Open attachment"))
                                }
                            } catch (failure: Exception) { error = failure.message ?: "Could not open attachment" }
                        } }, onAnswer = { answers ->
                        scope.launch {
                            answeringQuestion = block.id
                            try { api.answerQuestion(server, chat, block, answers); history = api.history(server, chat); refresh() }
                            catch (failure: Exception) { error = failure.message ?: "Could not send answer" }
                            finally { answeringQuestion = "" }
                        }
                    }) }
                    if (blocks.isEmpty()) item { CenterState("This chat has no messages yet.", "Refresh") {
                        scope.launch { history = api.history(server, chat) }
                    } }
                    item { Spacer(Modifier.height(20.dp)) }
                }
                if (history?.transcript?.uncertain == true) ErrorLine("Turn interrupted. Review the last messages before continuing.")
                ChatComposer(draft, { draft = it }, enabled = !busy, working = working, harness = chat.harness,
                    settings = chatSettings, onSettings = { showChatSettings = true },
                    onDictate = {
                        try { speechPicker.launch(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)) }
                        catch (_: ActivityNotFoundException) { error = "Speech recognition is unavailable on this phone" }
                    },
                    attachments = attachments, uploading = uploading,
                    onPick = { attachmentPicker.launch("*/*") },
                    onRemoveAttachment = { item -> attachments = attachments.filterNot { it.id == item.id } },
                    onStop = {
                        scope.launch {
                            try { api.stop(server, chat); history = api.history(server, chat); refresh() }
                            catch (failure: Exception) { error = failure.message.orEmpty() }
                        }
                    }) {
                    val text = draft.trim()
                    if (text.isEmpty() && attachments.isEmpty()) return@ChatComposer
                    busy = true
                    scope.launch {
                        try {
                            api.send(server, chat, text, steer = working, attachments = attachments.map { it.id })
                            draft = ""
                            attachments = emptyList()
                            if (sharedText != null && text == sharedText) clearShare()
                            history = api.history(server, chat)
                            refresh()
                        } catch (failure: Exception) { error = failure.message ?: "Message was not sent" }
                        finally { busy = false }
                    }
                }
            }
        }
    }

    if (showServer) ServerDialog(server, onDismiss = { showServer = false }, onSave = { url ->
        server = url
        UrlResolver.saveUrl(context, url)
        snapshot = null
        selectedChat = null
        showServer = false
    })
    if (showNewProject) NewProjectDialog(snapshot?.nodes.orEmpty(), onDismiss = { showNewProject = false }, onCreate = { node, name ->
        scope.launch {
            try { api.createProject(server, node.id, name); refresh(); showNewProject = false }
            catch (failure: Exception) { error = failure.message ?: "Project could not be created" }
        }
    })
    newChatProject?.let { project ->
        NewChatDialog(project, sharedText.orEmpty(), api, server, onDismiss = { newChatProject = null }, onCreate = { harness, prompt ->
            scope.launch {
                busy = true
                try {
                    val chat = api.createChat(server, project, harness, prompt)
                    newChatProject = null
                    selectedChat = chat
                    draft = ""
                    attachments = emptyList()
                    if (sharedText != null && prompt == sharedText) clearShare()
                    refresh()
                } catch (failure: Exception) { error = failure.message ?: "Chat could not be created" }
                finally { busy = false }
            }
        })
    }
    if (showChatSettings && selectedChat != null) SettingsDialog(chatSettings,
        history?.transcript?.running == true || selectedChat?.state == "starting",
        onDismiss = { showChatSettings = false }, onChange = { change ->
            scope.launch {
                try { chatSettings = api.updateSettings(server, selectedChat!!, change); refresh() }
                catch (failure: Exception) { error = failure.message ?: "Could not update chat settings" }
            }
        })
    editingBlock?.let { block ->
        AlertDialog(onDismissRequest = { editingBlock = null }, title = { Text("Edit in a new chat") },
            text = { OutlinedTextField(editDraft, { editDraft = it }, minLines = 3, maxLines = 8,
                modifier = Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(onClick = {
                val chat = selectedChat ?: return@TextButton
                val content = editDraft.trim()
                scope.launch {
                    busy = true
                    try {
                        selectedChat = api.branch(server, chat, block.id, "edit", content,
                            block.attachments.map { it.id })
                        editingBlock = null
                        refresh()
                    } catch (failure: Exception) { error = failure.message ?: "Could not edit message" }
                    finally { busy = false }
                }
            }, enabled = editDraft.isNotBlank() && !busy) { Text("Send edit") } },
            dismissButton = { TextButton(onClick = { editingBlock = null }) { Text("Cancel") } })
    }
}

@Composable
private fun Header(server: String, connected: Boolean, serverSettings: () -> Unit, openWorkspace: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 18.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("muxterm", fontSize = 26.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.8).sp,
                modifier = Modifier.weight(1f))
            TextButton(onClick = openWorkspace) { Text("Workspace") }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable(onClick = serverSettings)) {
            StatusDot(connected)
            Text(server.removePrefix("https://").removePrefix("http://").take(48),
                color = secondary, fontSize = 13.sp, modifier = Modifier.padding(start = 7.dp))
            Text("  ·  Change server", color = blue, fontSize = 13.sp)
        }
    }
    HorizontalDivider(color = line)
}

@Composable
private fun ShareBanner(text: String, discard: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Ready to share", fontWeight = FontWeight.SemiBold, color = blue, modifier = Modifier.weight(1f))
            TextButton(onClick = discard) { Text("Discard") }
        }
        Text(text.take(150), maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 13.sp, color = secondary)
        Text("Choose a chat or start one. Nothing is sent until you press Send.", fontSize = 12.sp, color = secondary)
    }
    HorizontalDivider(color = line)
}

@Composable
private fun ProjectList(
    snapshot: SatelliteSnapshot,
    expanded: MutableMap<String, Boolean>,
    hasShare: Boolean,
    onProjectChat: (SatelliteProject) -> Unit,
    onChat: (SatelliteChat) -> Unit,
) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        for (node in snapshot.nodes) {
            item(key = "node:${node.id}") { NodeRow(node) }
            val projects = snapshot.projects.filter { it.nodeId == node.id }
                .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
            for (project in projects) {
                val key = "${node.id}:${project.id}"
                item(key = "project:$key") {
                    ProjectRow(project, node.id.isNotBlank(), expanded[key] != false,
                        onToggle = { expanded[key] = expanded[key] == false },
                        onNewChat = { onProjectChat(project) })
                }
                if (expanded[key] != false) {
                    val chats = snapshot.chats.filter { it.nodeId == node.id && it.projectId == project.id }
                    for (chat in chats) item(key = "chat:${node.id}:${chat.id}") { ChatListRow(chat, hasShare) { onChat(chat) } }
                    if (chats.isEmpty()) item(key = "empty:$key") {
                        Text("No chats yet", color = secondary, fontSize = 13.sp,
                            modifier = Modifier.padding(start = 52.dp, top = 4.dp, bottom = 13.dp))
                    }
                }
            }
            if (projects.isEmpty()) item(key = "empty-node:${node.id}") {
                Text(if (node.state == "connected") "No projects on this node" else "Connect this node in the workspace",
                    color = secondary, fontSize = 13.sp, modifier = Modifier.padding(start = 22.dp, bottom = 14.dp))
            }
        }
        if (snapshot.nodes.size == 1 && snapshot.projects.isEmpty()) item {
            Text("Create a project to start a chat on this server.", color = secondary,
                modifier = Modifier.padding(20.dp))
        }
    }
}

@Composable
private fun NodeRow(node: SatelliteNode) {
    Row(modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 7.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(if (node.id.isBlank()) "This server" else node.name, fontWeight = FontWeight.SemiBold,
            fontSize = 13.sp, color = secondary, modifier = Modifier.weight(1f))
        Text(if (node.state == "connected") "Connected" else node.state.replaceFirstChar { it.uppercase() },
            fontSize = 12.sp, color = secondary)
        Spacer(Modifier.size(6.dp))
        StatusDot(node.state == "connected")
    }
}

@Composable
private fun ProjectRow(project: SatelliteProject, remote: Boolean, expanded: Boolean, onToggle: () -> Unit, onNewChat: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(start = 19.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically) {
        FolderMark(remote)
        Column(modifier = Modifier.weight(1f).padding(start = 10.dp)) {
            Text(project.name, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (remote) Text("Network project", fontSize = 11.sp, color = secondary)
        }
        TextButton(onClick = onNewChat) { Text("New chat") }
        Text(if (expanded) "⌄" else "›", color = secondary, fontSize = 21.sp, modifier = Modifier.padding(start = 3.dp))
    }
}

@Composable
private fun ChatListRow(chat: SatelliteChat, hasShare: Boolean, onClick: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 50.dp, end = 20.dp, top = 9.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = Modifier.weight(1f)) {
            Text(chat.title.ifBlank { "Untitled chat" }, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val activity = chat.lastActivity.ifBlank { chat.harness.replaceFirstChar { it.uppercase() } }
            Text(activity, fontSize = 12.sp, color = secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (chat.state == "working") StatusDot(true)
        else if (chat.state == "blocked" || chat.state == "uncertain") Text("Needs attention", color = amber, fontSize = 11.sp)
        else if (hasShare) Text("Share here", color = blue, fontSize = 11.sp)
    }
}

@Composable
private fun ChatHeader(chat: SatelliteChat, node: String, onBack: () -> Unit, openWorkspace: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = 12.dp, top = 6.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = onBack) { Text("‹ Projects", fontSize = 15.sp) }
        Column(modifier = Modifier.weight(1f).padding(start = 4.dp)) {
            Text(chat.title.ifBlank { "Untitled chat" }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("$node  ·  ${chat.harness}", color = secondary, fontSize = 11.sp)
        }
        TextButton(onClick = openWorkspace) { Text("More") }
    }
    HorizontalDivider(color = line)
}

@Composable
private fun ChatBlockRow(block: ChatBlock, all: List<ChatBlock>, index: Int, working: Boolean,
    questionPending: Boolean, canBranch: Boolean, onEdit: (ChatBlock) -> Unit, onFork: (String) -> Unit,
    loadImage: suspend (ChatAttachment) -> ImageBitmap?, onAttachment: (ChatAttachment) -> Unit,
    onAnswer: (Map<String, String>) -> Unit) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(block.id, block.text) { mutableStateOf(false) }
    val time = remember(block.at) { runCatching {
        java.time.Instant.parse(block.at).atZone(java.time.ZoneId.systemDefault())
            .format(java.time.format.DateTimeFormatter.ofPattern("h:mm a"))
    }.getOrNull().orEmpty() }
    when (block.kind) {
        ChatBlockKind.USER -> Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 26.dp, vertical = 9.dp),
            horizontalAlignment = Alignment.End,
        ) {
            Surface(color = userTint, shape = RoundedCornerShape(18.dp), modifier = Modifier.widthIn(max = 320.dp)) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                    if (block.text.isNotBlank()) Text(block.text, color = ink, fontSize = 14.sp, lineHeight = 22.sp)
                    block.attachments.forEach { item ->
                        if (item.kind == "image") NativeAttachmentImage(item, loadImage, onAttachment)
                        else Text("📎 ${item.name}", color = blue, fontSize = 12.sp,
                            modifier = Modifier.clickable { onAttachment(item) }.padding(top = 5.dp))
                    }
                }
            }
            Row(Modifier.padding(top = 3.dp, end = 5.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(if (copied) "Copied" else "Copy", color = secondary, fontSize = 11.sp,
                    modifier = Modifier.clickable { clipboard.setText(AnnotatedString(block.text)); copied = true })
                if (canBranch && block.kind == ChatBlockKind.USER && block.id.isNotBlank())
                    Text("Edit", color = secondary, fontSize = 11.sp, modifier = Modifier.clickable { onEdit(block) })
                if (time.isNotBlank()) Text(time, color = secondary, fontSize = 11.sp)
            }
        }
        ChatBlockKind.ACTIVITY, ChatBlockKind.COMMENTARY, ChatBlockKind.STEER -> {
            val workKinds = listOf(ChatBlockKind.ACTIVITY, ChatBlockKind.COMMENTARY, ChatBlockKind.STEER)
            if (all.take(index).any { it.turn == block.turn && it.kind in workKinds }) return
            val work = all.filter { it.turn == block.turn && it.kind in workKinds }
            val done = all.drop(index).any { it.turn == block.turn && it.kind in listOf(ChatBlockKind.ASSISTANT, ChatBlockKind.STATUS, ChatBlockKind.ERROR) } || !working
            WorkDisclosure(work, done, all.any { it.turn == block.turn && it.kind == ChatBlockKind.QUESTION && !it.done })
        }
        ChatBlockKind.ASSISTANT -> Column(Modifier.fillMaxWidth().padding(start = 26.dp, end = 26.dp, top = 15.dp, bottom = 10.dp)) {
            NativeMarkdown(block.text)
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(if (copied) "Copied" else "Copy", color = secondary, fontSize = 11.sp,
                    modifier = Modifier.clickable { clipboard.setText(AnnotatedString(block.text)); copied = true })
                val anchor = all.take(index + 1).lastOrNull { it.turn == block.turn && it.kind == ChatBlockKind.USER }?.id.orEmpty()
                if (canBranch && anchor.isNotBlank() && all.drop(index + 1).none { it.turn == block.turn && it.kind == ChatBlockKind.ASSISTANT })
                    Text("Fork", color = secondary, fontSize = 11.sp, modifier = Modifier.clickable { onFork(anchor) })
                if (time.isNotBlank()) Text(time, color = secondary, fontSize = 11.sp)
            }
        }
        ChatBlockKind.QUESTION -> QuestionCard(block, questionPending, onAnswer)
        ChatBlockKind.STATUS, ChatBlockKind.ERROR -> Text(block.text,
            color = if (block.kind == ChatBlockKind.ERROR) Color(0xFF9A3D36) else secondary,
            fontSize = 12.sp, modifier = Modifier.fillMaxWidth().padding(horizontal = 26.dp, vertical = 8.dp))
    }
}

@Composable
private fun NativeAttachmentImage(item: ChatAttachment, loadImage: suspend (ChatAttachment) -> ImageBitmap?,
    onOpen: (ChatAttachment) -> Unit) {
    var bitmap by remember(item.id) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(item.id) { bitmap = runCatching { loadImage(item) }.getOrNull() }
    if (bitmap == null) Text("📎 ${item.name}", color = blue, fontSize = 12.sp,
        modifier = Modifier.clickable { onOpen(item) }.padding(top = 5.dp))
    else Image(bitmap!!, contentDescription = item.name, contentScale = ContentScale.Fit,
        modifier = Modifier.widthIn(max = 240.dp).heightIn(max = 180.dp).padding(top = 6.dp)
            .clickable { onOpen(item) })
}

@Composable
private fun QuestionCard(block: ChatBlock, pending: Boolean, onAnswer: (Map<String, String>) -> Unit) {
    val answers = remember(block.id) { mutableStateMapOf<String, String>() }
    Surface(color = raised, shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 26.dp, vertical = 7.dp).border(1.dp, line, RoundedCornerShape(12.dp))) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Text(if (block.done) "Codex asked · Answered" else "Codex asks", color = ink,
                fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            if (block.questions.isEmpty()) Text(block.text, color = ink, fontSize = 14.sp)
            block.questions.forEach { question ->
                Text(listOf(question.header, question.prompt).filter { it.isNotBlank() }.joinToString(" · "),
                    color = ink, fontSize = 14.sp)
                if (!block.done) {
                    question.options.forEach { option ->
                        Row(Modifier.fillMaxWidth().clickable { answers[question.id] = option },
                            verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = answers[question.id] == option,
                                onClick = { answers[question.id] = option })
                            Text(option, color = ink, fontSize = 13.sp)
                        }
                    }
                    if (question.options.isEmpty() || question.isOther) OutlinedTextField(
                        value = answers[question.id].orEmpty(), onValueChange = { answers[question.id] = it },
                        label = { Text(if (question.isOther) "Other answer" else "Your answer") },
                        visualTransformation = if (question.isSecret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                        modifier = Modifier.fillMaxWidth(), maxLines = 3)
                }
            }
            if (!block.done) Button(onClick = { onAnswer(answers.toMap()) },
                enabled = !pending && block.questions.isNotEmpty() && block.questions.all { answers[it.id]?.isNotBlank() == true },
                modifier = Modifier.align(Alignment.End)) { Text(if (pending) "Sending…" else "Send answer") }
        }
    }
}

@Composable
private fun WorkDisclosure(work: List<ChatBlock>, done: Boolean, waitingQuestion: Boolean) {
    var expanded by remember(work.firstOrNull()?.turn) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 26.dp, vertical = 7.dp)) {
        Row(Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text(if (waitingQuestion) "Waiting for your answer" else if (done)
                work.firstNotNullOfOrNull { it.durationSeconds }?.let { seconds ->
                    "Worked for " + if (seconds < 60) "${seconds}s" else "${seconds / 60}m ${seconds % 60}s"
                } ?: "Worked"
                else "Working…",
                color = secondary, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text(if (expanded) "⌃" else "⌄", color = secondary, fontSize = 15.sp)
        }
        HorizontalDivider(color = line)
        val details = work.filter { it.name != "Working" || it.text.isNotBlank() }
        if (expanded && details.isEmpty()) Text("Working on your request…", color = secondary, fontSize = 12.sp,
            modifier = Modifier.padding(vertical = 8.dp))
        if (expanded) details.forEach { item ->
            Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
                if (item.kind == ChatBlockKind.ACTIVITY && item.name != "Working") Text("${if (item.failed) "!" else if (item.done) "✓" else "◌"}  ${item.name}",
                    color = secondary, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                if (item.kind == ChatBlockKind.STEER) Text("Your interjection", color = secondary,
                    fontSize = 12.sp, fontWeight = FontWeight.Medium)
                if (item.text.isNotBlank()) {
                    if (item.kind == ChatBlockKind.STEER) Text(item.text, color = ink, fontSize = 13.sp, lineHeight = 19.sp)
                    else NativeMarkdown(item.text, compact = true)
                }
            }
        }
    }
}

@Composable
private fun ChatComposer(value: String, onChange: (String) -> Unit, enabled: Boolean, working: Boolean,
    harness: String, settings: SatelliteChatSettings?, onSettings: () -> Unit, onDictate: () -> Unit,
    attachments: List<ChatAttachment>, uploading: Boolean,
    onPick: () -> Unit, onRemoveAttachment: (ChatAttachment) -> Unit, onStop: () -> Unit, onSend: () -> Unit) {
    Surface(color = paper) {
        Surface(color = raised, shape = RoundedCornerShape(15.dp), shadowElevation = 5.dp,
            modifier = Modifier.fillMaxWidth().padding(start = 11.dp, end = 11.dp, bottom = 12.dp).border(1.dp, line, RoundedCornerShape(15.dp))) {
            Column(Modifier.padding(start = 14.dp, end = 10.dp, top = 13.dp, bottom = 5.dp)) {
                if (attachments.isNotEmpty()) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    attachments.forEach { item ->
                        Text("${item.name.take(16)}  ×", color = ink, fontSize = 11.sp,
                            modifier = Modifier.background(userTint, RoundedCornerShape(7.dp))
                                .clickable { onRemoveAttachment(item) }.padding(horizontal = 7.dp, vertical = 5.dp))
                    }
                }
                Box(Modifier.fillMaxWidth().heightIn(min = 50.dp, max = 220.dp)) {
                    if (value.isEmpty()) Text(if (working) "Steer this turn…" else "Message ${harness.ifBlank { "agent" }}…",
                        color = secondary, fontSize = 14.sp, modifier = Modifier.padding(top = 5.dp))
                    BasicTextField(value, onChange, enabled = enabled, modifier = Modifier.fillMaxWidth(),
                        textStyle = androidx.compose.ui.text.TextStyle(color = ink, fontSize = 14.sp, lineHeight = 22.sp),
                        minLines = 2, maxLines = 10)
                }
                Row(Modifier.fillMaxWidth().height(44.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(42.dp).semantics { contentDescription = "Attach file" }
                        .clickable(enabled = !working && !uploading && attachments.size < 10) { onPick() },
                        contentAlignment = Alignment.Center) {
                        Image(painterResource(R.drawable.ic_chat_paperclip), contentDescription = null,
                            colorFilter = ColorFilter.tint(secondary), modifier = Modifier.size(18.dp))
                    }
                    val permission = settings?.permission?.let { when (it) {
                        "full-permission" -> "Full access"; "workspace-write" -> "Workspace write"; "read-only" -> "Read only"; else -> it
                    } } ?: harness.replaceFirstChar { it.uppercase() }
                    Text(permission + if (settings?.mode == "plan") " · Plan" else "", color = secondary, fontSize = 11.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable(onClick = onSettings).weight(1f))
                    settings?.model?.takeIf { it.isNotBlank() }?.let { model ->
                        Text(settings.models.firstOrNull { it.id == model }?.label ?: model,
                            color = secondary, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.widthIn(max = 90.dp).clickable(onClick = onSettings).padding(horizontal = 6.dp))
                    }
                    if (uploading) CircularProgressIndicator(modifier = Modifier.size(26.dp), strokeWidth = 2.dp)
                    else Surface(color = if (enabled) blue else line, shape = CircleShape,
                        modifier = Modifier.size(34.dp).semantics { contentDescription =
                            if (working && value.isBlank()) "Stop current task" else if (working) "Steer current task"
                            else if (value.isBlank() && attachments.isEmpty()) "Dictate message" else "Send message" }
                            .clickable(enabled = enabled && !uploading && !(working && attachments.isNotEmpty())) {
                            if (value.isNotBlank() || attachments.isNotEmpty()) onSend() else if (working) onStop() else onDictate()
                        }) {
                        Box(contentAlignment = Alignment.Center) {
                            Image(painterResource(if (working && value.isBlank()) R.drawable.ic_chat_stop
                                else if (value.isBlank() && attachments.isEmpty()) R.drawable.ic_chat_voice
                                else R.drawable.ic_chat_arrow_up),
                                contentDescription = null, colorFilter = ColorFilter.tint(Color.White), modifier = Modifier.size(17.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsDialog(settings: SatelliteChatSettings?, working: Boolean,
    onDismiss: () -> Unit, onChange: (JSONObject) -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Chat controls") },
        text = {
            if (settings == null) Text("Controls are unavailable for this chat.", color = secondary)
            else Column(Modifier.heightIn(max = 550.dp).verticalScroll(rememberScrollState())) {
                if (working) Text("Finish this turn before changing controls.", color = secondary, fontSize = 12.sp)
                Text("Permission", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                settings.permissions.forEach { value ->
                    val label = when (value) { "full-permission" -> "Full access"; "workspace-write" -> "Workspace write"; "read-only" -> "Read only"; else -> value }
                    Row(Modifier.fillMaxWidth().clickable(enabled = !working) { onChange(JSONObject().put("permission", value)) }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = settings.permission == value, onClick = { onChange(JSONObject().put("permission", value)) }, enabled = !working)
                        Text(label, fontSize = 13.sp)
                    }
                }
                Text("Mode", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                settings.modes.forEach { value ->
                    Row(Modifier.fillMaxWidth().clickable(enabled = !working) { onChange(JSONObject().put("mode", value)) }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = settings.mode == value, onClick = { onChange(JSONObject().put("mode", value)) }, enabled = !working)
                        Text(value.replaceFirstChar { it.uppercase() }, fontSize = 13.sp)
                    }
                }
                Text("Model", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                settings.models.forEach { model ->
                    Row(Modifier.fillMaxWidth().clickable(enabled = !working) { onChange(JSONObject().put("model", model.id)) }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = settings.model == model.id, onClick = { onChange(JSONObject().put("model", model.id)) }, enabled = !working)
                        Text(model.label.ifBlank { model.id }, fontSize = 13.sp)
                    }
                }
                val efforts = settings.models.firstOrNull { it.id == settings.model }?.efforts.orEmpty()
                if (efforts.size > 1) {
                    Text("Thinking", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
                    efforts.forEach { value ->
                        Row(Modifier.fillMaxWidth().clickable(enabled = !working) { onChange(JSONObject().put("effort", value)) }, verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = settings.effort == value, onClick = { onChange(JSONObject().put("effort", value)) }, enabled = !working)
                            Text(value.replaceFirstChar { it.uppercase() }, fontSize = 13.sp)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } })
}

@Composable
private fun NewProjectDialog(nodes: List<SatelliteNode>, onDismiss: () -> Unit, onCreate: (SatelliteNode, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf(nodes.firstOrNull { it.state == "connected" }) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("New project") },
        text = {
            Column {
                Text("Create a project folder on a connected node.", color = secondary, fontSize = 13.sp)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(name, { name = it }, label = { Text("Project name") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (name.isNotBlank() && selected != null) onCreate(selected!!, name.trim()) }))
                Spacer(Modifier.height(12.dp))
                nodes.filter { it.state == "connected" }.forEach { node ->
                    Row(modifier = Modifier.fillMaxWidth().clickable { selected = node }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = selected?.id == node.id, onClick = { selected = node })
                        Text(if (node.id.isBlank()) "This server" else node.name)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { selected?.let { onCreate(it, name.trim()) } }, enabled = name.isNotBlank() && selected != null) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable
private fun NewChatDialog(
    project: SatelliteProject, sharedText: String, api: SatelliteApi, server: String,
    onDismiss: () -> Unit, onCreate: (SatelliteHarness, String) -> Unit,
) {
    var prompt by remember(project.id, sharedText) { mutableStateOf(sharedText) }
    var options by remember(project.id) { mutableStateOf<List<SatelliteHarness>>(emptyList()) }
    var selected by remember(project.id) { mutableStateOf<SatelliteHarness?>(null) }
    var loadError by remember(project.id) { mutableStateOf("") }
    LaunchedEffect(server, project.id, project.nodeId) {
        try {
            options = api.harnesses(server, project.nodeId)
            selected = options.firstOrNull()
        } catch (failure: Exception) { loadError = failure.message ?: "Could not load agents" }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("New chat in ${project.name}") },
        text = {
            Column {
                Text(if (project.nodeId.isBlank()) "Runs on this server" else "Runs on ${project.nodeId.substringAfter(':')}",
                    color = secondary, fontSize = 13.sp)
                Spacer(Modifier.height(10.dp))
                if (loadError.isNotBlank()) Text(loadError, color = amber, fontSize = 13.sp)
                if (options.isEmpty() && loadError.isBlank()) CircularProgressIndicator(modifier = Modifier.size(22.dp))
                options.forEach { harness ->
                    Row(modifier = Modifier.fillMaxWidth().clickable { selected = harness }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = selected == harness, onClick = { selected = harness })
                        Text(harness.name.replaceFirstChar { it.uppercase() })
                    }
                }
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(prompt, { prompt = it }, label = { Text("First message") }, minLines = 3, maxLines = 7)
            }
        },
        confirmButton = { TextButton(onClick = { selected?.let { onCreate(it, prompt.trim()) } }, enabled = selected != null && prompt.isNotBlank()) { Text("Start chat") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable
private fun ServerDialog(current: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var url by remember { mutableStateOf(current) }
    val valid = remember(url) {
        val parsed = android.net.Uri.parse(url.trim())
        parsed.host != null && (parsed.scheme == "https" ||
            (parsed.scheme == "http" && parsed.host in listOf("localhost", "127.0.0.1", "10.0.2.2")))
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Muxterm server") },
        text = {
            Column {
                Text("Use the address you open in a browser. Sign in once through the workspace.", color = secondary, fontSize = 13.sp)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(url, { url = it }, label = { Text("Server URL") }, singleLine = true)
                if (!valid) Text("Use HTTPS, or HTTP on localhost for development.", color = amber, fontSize = 12.sp)
            }
        },
        confirmButton = { TextButton(onClick = { onSave(url.trim().trimEnd('/')) }, enabled = valid) { Text("Connect") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable
private fun CenterProgress() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
private fun CenterState(message: String, action: String, onAction: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(message, color = secondary)
        Spacer(Modifier.height(10.dp))
        Button(onClick = onAction) { Text(action) }
    }
}

@Composable
private fun ErrorLine(message: String) {
    Text(message, color = Color(0xFF9A3D36), fontSize = 12.sp,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp))
}

@Composable
private fun StatusDot(connected: Boolean) {
    Canvas(modifier = Modifier.size(8.dp)) { drawCircle(if (connected) green else amber) }
}

@Composable
private fun FolderMark(remote: Boolean) {
    Canvas(modifier = Modifier.size(22.dp)) {
        val path = Path().apply {
            moveTo(size.width * .08f, size.height * .28f)
            lineTo(size.width * .42f, size.height * .28f)
            lineTo(size.width * .52f, size.height * .39f)
            lineTo(size.width * .92f, size.height * .39f)
            lineTo(size.width * .84f, size.height * .82f)
            lineTo(size.width * .13f, size.height * .82f)
            close()
        }
        drawPath(path, if (remote) blue else secondary)
        if (remote) drawCircle(green, radius = size.minDimension * .13f,
            center = androidx.compose.ui.geometry.Offset(size.width * .79f, size.height * .78f))
    }
}
