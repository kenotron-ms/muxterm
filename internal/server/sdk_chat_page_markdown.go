package server

import (
	"net/url"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// markdownPageBlocks converts common Markdown structure to BlockNote's native
// document shape. Widgets are deliberately separate from prose conversion.
func markdownPageBlocks(markdown string) []map[string]any {
	source := []byte(markdown)
	doc := goldmark.DefaultParser().Parse(text.NewReader(source))
	var blocks []map[string]any
	var visit func(ast.Node)
	visit = func(node ast.Node) {
		switch n := node.(type) {
		case *ast.Heading:
			level := n.Level
			if level > 3 {
				level = 3
			}
			blocks = append(blocks, map[string]any{"type": "heading", "props": map[string]any{"level": level}, "content": pageInline(n, source)})
		case *ast.Paragraph, *ast.TextBlock:
			blocks = append(blocks, map[string]any{"type": "paragraph", "content": pageInline(n, source)})
		case *ast.List:
			for child := n.FirstChild(); child != nil; child = child.NextSibling() {
				item := child.FirstChild()
				if item == nil {
					continue
				}
				kind := "bulletListItem"
				if n.IsOrdered() {
					kind = "numberedListItem"
				}
				blocks = append(blocks, map[string]any{"type": kind, "content": pageInline(item, source)})
				for nested := item.NextSibling(); nested != nil; nested = nested.NextSibling() {
					visit(nested)
				}
			}
		case *ast.Blockquote:
			for child := n.FirstChild(); child != nil; child = child.NextSibling() {
				blocks = append(blocks, map[string]any{"type": "quote", "content": pageInline(child, source)})
			}
		case *ast.FencedCodeBlock:
			blocks = append(blocks, map[string]any{"type": "codeBlock", "props": map[string]any{"language": string(n.Language(source))}, "content": pageCode(n.Lines(), source)})
		case *ast.CodeBlock:
			blocks = append(blocks, map[string]any{"type": "codeBlock", "content": pageCode(n.Lines(), source)})
		case *ast.ThematicBreak:
			blocks = append(blocks, map[string]any{"type": "divider"})
		default:
			for child := n.FirstChild(); child != nil; child = child.NextSibling() {
				visit(child)
			}
		}
	}
	visit(doc)
	return blocks
}

func pageCode(lines *text.Segments, source []byte) string {
	var out strings.Builder
	for i := 0; i < lines.Len(); i++ {
		segment := lines.At(i)
		out.Write(segment.Value(source))
	}
	return strings.TrimSuffix(out.String(), "\n")
}

func pageInline(node ast.Node, source []byte) []map[string]any {
	var out []map[string]any
	var walk func(ast.Node, map[string]bool)
	walk = func(n ast.Node, styles map[string]bool) {
		switch v := n.(type) {
		case *ast.Text:
			t := string(v.Segment.Value(source))
			if v.HardLineBreak() || v.SoftLineBreak() {
				t += "\n"
			}
			if t != "" {
				out = append(out, map[string]any{"type": "text", "text": t, "styles": styles})
			}
			return
		case *ast.String:
			out = append(out, map[string]any{"type": "text", "text": string(v.Value), "styles": styles})
			return
		case *ast.CodeSpan:
			copy := clonePageStyles(styles)
			copy["code"] = true
			for child := n.FirstChild(); child != nil; child = child.NextSibling() {
				walk(child, copy)
			}
			return
		case *ast.Emphasis:
			copy := clonePageStyles(styles)
			if v.Level == 2 {
				copy["bold"] = true
			} else {
				copy["italic"] = true
			}
			for child := n.FirstChild(); child != nil; child = child.NextSibling() {
				walk(child, copy)
			}
			return
		case *ast.Link:
			var label strings.Builder
			for child := n.FirstChild(); child != nil; child = child.NextSibling() {
				label.WriteString(string(child.Text(source)))
			}
			href := string(v.Destination)
			parsed, err := url.Parse(href)
			if err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https" || parsed.Scheme == "mailto" || parsed.Scheme == "" && !strings.HasPrefix(href, "//")) {
				out = append(out, map[string]any{"type": "link", "href": href, "content": label.String()})
			} else {
				out = append(out, map[string]any{"type": "text", "text": label.String(), "styles": styles})
			}
			return
		}
		for child := n.FirstChild(); child != nil; child = child.NextSibling() {
			walk(child, styles)
		}
	}
	walk(node, map[string]bool{})
	return out
}

func clonePageStyles(styles map[string]bool) map[string]bool {
	copy := make(map[string]bool, len(styles)+1)
	for key, value := range styles {
		copy[key] = value
	}
	return copy
}
