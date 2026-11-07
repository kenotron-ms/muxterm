package io.ampbox.muxterm

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text as MarkdownLiteral
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

private val markdownParser = Parser.builder().extensions(listOf(TablesExtension.create(), StrikethroughExtension.create())).build()
private val markdownInk = Color(0xFF1C1C1E)
private val markdownMuted = Color(0xFF5C5C5F)
private val markdownAccent = Color(0xFF005BB5)

/** Native Compose text and layout for assistant Markdown. Raw HTML stays text. */
@Composable
internal fun NativeMarkdown(source: String, modifier: Modifier = Modifier, compact: Boolean = false) {
    val root = remember(source) { markdownParser.parse(source) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(if (compact) 5.dp else 10.dp)) {
        for (child in root.children()) MarkdownBlock(child, compact)
    }
}

@Composable
private fun MarkdownBlock(node: Node, compact: Boolean) {
    when (node) {
        is Heading -> MarkdownInline(node, TextStyle(color = markdownInk, fontSize = if (compact) 14.sp else (21 - node.level.coerceAtMost(4)).sp,
            lineHeight = if (compact) 21.sp else 26.sp, fontWeight = FontWeight.SemiBold))
        is Paragraph -> MarkdownInline(node, TextStyle(color = markdownInk, fontSize = if (compact) 13.sp else 15.sp,
            lineHeight = if (compact) 19.sp else 24.sp))
        is FencedCodeBlock -> CodeBlock(node.literal)
        is IndentedCodeBlock -> CodeBlock(node.literal)
        is BulletList -> node.children().forEach { item -> ListItemRow(item, "•", compact) }
        is OrderedList -> node.children().forEachIndexed { index, item -> ListItemRow(item, "${(node.markerStartNumber ?: 1) + index}.", compact) }
        is BlockQuote -> Row(Modifier.fillMaxWidth()) {
            Box(Modifier.width(3.dp).background(markdownMuted))
            Column(Modifier.padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                node.children().forEach { MarkdownBlock(it, compact) }
            }
        }
        is ThematicBreak -> HorizontalDivider(color = markdownMuted.copy(alpha = 0.45f))
        is TableBlock -> Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            node.children().forEach { section -> section.children().forEach { row ->
                if (row is TableRow) Row(Modifier.fillMaxWidth()) {
                    row.children().forEach { cell -> if (cell is TableCell) Box(Modifier.weight(1f).padding(5.dp)) {
                        MarkdownInline(cell, TextStyle(color = markdownInk, fontSize = 13.sp, lineHeight = 18.sp,
                            fontWeight = if (cell.isHeader) FontWeight.SemiBold else FontWeight.Normal))
                    } }
                }
            } }
        }
        is ListItem -> node.children().forEach { MarkdownBlock(it, compact) }
        else -> node.children().forEach { MarkdownBlock(it, compact) }
    }
}

@Composable
private fun ListItemRow(item: Node, marker: String, compact: Boolean) {
    Row(Modifier.fillMaxWidth()) {
        Text(marker, color = markdownMuted, fontSize = if (compact) 13.sp else 15.sp,
            modifier = Modifier.width(25.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            item.children().forEach { MarkdownBlock(it, compact) }
        }
    }
}

@Composable
private fun CodeBlock(value: String) {
    Text(value.trimEnd(), color = markdownInk, fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 18.sp,
        modifier = Modifier.fillMaxWidth().background(Color(0xFFE8E8EE)).padding(10.dp))
}

@Composable
private fun MarkdownInline(node: Node, style: TextStyle) {
    val uriHandler = LocalUriHandler.current
    val value = remember(node) { buildAnnotatedString { appendMarkdownChildren(node) } }
    androidx.compose.foundation.text.ClickableText(value, style = style, onClick = { offset ->
        value.getStringAnnotations("URL", offset, offset).firstOrNull()?.item?.let { uri ->
            if (uri.startsWith("https://") || uri.startsWith("http://")) uriHandler.openUri(uri)
        }
    })
}

private fun AnnotatedString.Builder.appendMarkdownChildren(parent: Node) {
    parent.children().forEach { node -> when (node) {
        is MarkdownLiteral -> append(node.literal)
        is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Color(0xFFE8E8EE))) { append(node.literal) }
        is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { appendMarkdownChildren(node) }
        is Emphasis -> withStyle(SpanStyle(fontStyle = androidx.compose.ui.text.font.FontStyle.Italic)) { appendMarkdownChildren(node) }
        is Strikethrough -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { appendMarkdownChildren(node) }
        is Link -> {
            val start = length
            withStyle(SpanStyle(color = markdownAccent, textDecoration = TextDecoration.Underline)) { appendMarkdownChildren(node) }
            addStringAnnotation("URL", node.destination, start, length)
        }
        is Image -> { append("[Image: "); appendMarkdownChildren(node); append("]") }
        is SoftLineBreak -> append(" ")
        is HardLineBreak -> append("\n")
        is HtmlInline -> append(node.literal)
        else -> appendMarkdownChildren(node)
    } }
}

private fun Node.children(): List<Node> = buildList {
    var child = firstChild
    while (child != null) { add(child); child = child.next }
}
