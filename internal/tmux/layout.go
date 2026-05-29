package tmux

import (
	"fmt"
	"strings"
)

// NodeType represents the type of a layout node.
type NodeType int

const (
	// PaneNode is a leaf node representing a single pane.
	PaneNode NodeType = iota
	// HSplit is a horizontal split (children arranged left-to-right, delimited by {}).
	HSplit
	// VSplit is a vertical split (children arranged top-to-bottom, delimited by []).
	VSplit
)

// String returns the string representation of a NodeType.
func (n NodeType) String() string {
	switch n {
	case PaneNode:
		return "PaneNode"
	case HSplit:
		return "HSplit"
	case VSplit:
		return "VSplit"
	default:
		return fmt.Sprintf("NodeType(%d)", int(n))
	}
}

// LayoutNode represents a node in a tmux layout tree.
type LayoutNode struct {
	Type     NodeType
	Width    int
	Height   int
	XOff     int
	YOff     int
	PaneID   int           // only meaningful for PaneNode
	Children []*LayoutNode // only meaningful for HSplit/VSplit
}

// PaneIDs returns all pane IDs in left-to-right, top-to-bottom order
// via recursive collection.
func (n *LayoutNode) PaneIDs() []int {
	if n.Type == PaneNode {
		return []int{n.PaneID}
	}
	var ids []int
	for _, child := range n.Children {
		ids = append(ids, child.PaneIDs()...)
	}
	return ids
}

// layoutParser is a recursive descent parser for tmux layout strings.
type layoutParser struct {
	input string
	pos   int
}

// ParseLayout parses a tmux layout string into a LayoutNode tree.
// The format is "checksum,rootNode" where checksum is a hex string.
func ParseLayout(s string) (*LayoutNode, error) {
	// Strip the checksum prefix (everything before and including the first comma)
	idx := strings.IndexByte(s, ',')
	if idx < 0 {
		return nil, fmt.Errorf("invalid layout string: no checksum separator")
	}

	p := &layoutParser{
		input: s,
		pos:   idx + 1,
	}

	node, err := p.parseNode()
	if err != nil {
		return nil, err
	}
	return node, nil
}

// parseNode reads WxH,X,Y then dispatches based on the next character:
// '{' -> HSplit with parseChildren, '[' -> VSplit with parseChildren,
// ',' -> leaf pane with parseInt for pane ID.
func (p *layoutParser) parseNode() (*LayoutNode, error) {
	width, err := p.parseInt()
	if err != nil {
		return nil, fmt.Errorf("parsing width: %w", err)
	}
	if err := p.expectByte('x'); err != nil {
		return nil, err
	}
	height, err := p.parseInt()
	if err != nil {
		return nil, fmt.Errorf("parsing height: %w", err)
	}
	if err := p.expectByte(','); err != nil {
		return nil, err
	}
	xoff, err := p.parseInt()
	if err != nil {
		return nil, fmt.Errorf("parsing xoff: %w", err)
	}
	if err := p.expectByte(','); err != nil {
		return nil, err
	}
	yoff, err := p.parseInt()
	if err != nil {
		return nil, fmt.Errorf("parsing yoff: %w", err)
	}

	node := &LayoutNode{
		Width:  width,
		Height: height,
		XOff:   xoff,
		YOff:   yoff,
	}

	// Dispatch based on next character
	if p.pos >= len(p.input) {
		return nil, fmt.Errorf("unexpected end of input: expected pane ID or children")
	}

	switch p.input[p.pos] {
	case '{':
		node.Type = HSplit
		p.pos++ // consume '{'
		children, err := p.parseChildren('}')
		if err != nil {
			return nil, err
		}
		node.Children = children
	case '[':
		node.Type = VSplit
		p.pos++ // consume '['
		children, err := p.parseChildren(']')
		if err != nil {
			return nil, err
		}
		node.Children = children
	case ',':
		node.Type = PaneNode
		p.pos++ // consume ','
		paneID, err := p.parseInt()
		if err != nil {
			return nil, fmt.Errorf("parsing pane ID: %w", err)
		}
		node.PaneID = paneID
	default:
		return nil, fmt.Errorf("unexpected character %q at position %d", p.input[p.pos], p.pos)
	}

	return node, nil
}

// parseChildren reads nodes separated by commas until the closing bracket.
func (p *layoutParser) parseChildren(closeBracket byte) ([]*LayoutNode, error) {
	var children []*LayoutNode
	for {
		child, err := p.parseNode()
		if err != nil {
			return nil, err
		}
		children = append(children, child)
		if p.pos < len(p.input) && p.input[p.pos] == closeBracket {
			p.pos++ // consume closing bracket
			return children, nil
		}
		if err := p.expectByte(','); err != nil {
			return nil, fmt.Errorf("in children list: %w", err)
		}
	}
}

// parseInt reads a sequence of digits and returns the integer value.
func (p *layoutParser) parseInt() (int, error) {
	start := p.pos
	for p.pos < len(p.input) && p.input[p.pos] >= '0' && p.input[p.pos] <= '9' {
		p.pos++
	}
	if p.pos == start {
		return 0, fmt.Errorf("expected integer at position %d", p.pos)
	}
	n := 0
	for _, c := range p.input[start:p.pos] {
		n = n*10 + int(c-'0')
	}
	return n, nil
}

// expectByte checks that the current byte matches the expected byte and advances.
func (p *layoutParser) expectByte(expected byte) error {
	if p.pos >= len(p.input) {
		return fmt.Errorf("unexpected end of input: expected %q", expected)
	}
	if p.input[p.pos] != expected {
		return fmt.Errorf("expected %q at position %d, got %q", expected, p.pos, p.input[p.pos])
	}
	p.pos++
	return nil
}