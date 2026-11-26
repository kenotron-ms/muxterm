package server

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

type workGraphNode struct {
	Key          string        `json:"key"`
	Title        string        `json:"title"`
	Brief        string        `json:"brief"`
	Acceptance   string        `json:"acceptanceCriteria"`
	Goal         string        `json:"goalCondition"`
	DependsOn    []string      `json:"dependsOn"`
	NextAction   string        `json:"nextAction"`
	Plan         []sdkWorkStep `json:"plan"`
	PlanProtocol string        `json:"planProtocol"`
	UIWork       bool          `json:"uiWork"`
}

type workGraphFiling struct {
	ClientRef   string          `json:"clientRef"`
	Source      string          `json:"source"`
	ProjectIDs  *[]string       `json:"projectIds"`
	Integration string          `json:"integration"`
	Nodes       []workGraphNode `json:"nodes"`
}

type workGraphReceipt struct {
	Hash  string         `json:"hash"`
	Items []*sdkWorkItem `json:"items"`
}

func (h *sdkChatHost) workGraphDir() string {
	return filepath.Join(h.dir, "work", "graphs")
}

// Load the original filings first. Individual Work records supersede these
// snapshots as workers and humans update them.
func (h *sdkChatHost) loadWorkGraphs() {
	entries, err := os.ReadDir(h.workGraphDir())
	if err != nil && !os.IsNotExist(err) {
		log.Printf("read Work graphs: %v", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		receipt, err := readWorkGraph(filepath.Join(h.workGraphDir(), entry.Name()))
		if err != nil {
			log.Printf("read Work graph %s: %v", entry.Name(), err)
			continue
		}
		for _, item := range receipt.Items {
			h.workItems[item.ID] = item
		}
	}
}

func readWorkGraph(path string) (workGraphReceipt, error) {
	var receipt workGraphReceipt
	data, err := os.ReadFile(path)
	if err == nil {
		err = json.Unmarshal(data, &receipt)
	}
	return receipt, err
}

func workGraphOrder(req workGraphFiling) ([]workGraphNode, error) {
	nodes := make(map[string]workGraphNode, len(req.Nodes))
	titles := make(map[string]bool, len(req.Nodes))
	for _, node := range req.Nodes {
		title := strings.ToLower(strings.TrimSpace(node.Title))
		if node.Key == "" || strings.TrimSpace(node.Key) != node.Key || len(node.Key) > 64 || title == "" || len(node.Title) > 200 ||
			strings.TrimSpace(node.Brief) == "" || len(node.Brief) > 32<<10 || strings.TrimSpace(node.Acceptance) == "" ||
			len(node.Acceptance) > 16<<10 || len(node.NextAction) > 4096 || len([]rune(node.Goal)) > 4000 {
			return nil, fmt.Errorf("invalid Work graph node %q", node.Key)
		}
		if _, exists := nodes[node.Key]; exists || titles[title] {
			return nil, fmt.Errorf("duplicate Work graph node %q", node.Key)
		}
		nodes[node.Key] = node
		titles[title] = true
	}
	var ordered []workGraphNode
	state := make(map[string]int)
	var visit func(string) error
	visit = func(key string) error {
		node, exists := nodes[key]
		if !exists {
			return fmt.Errorf("unknown Work graph prerequisite %q", key)
		}
		switch state[key] {
		case 1:
			return fmt.Errorf("cyclic Work graph prerequisite %q", key)
		case 2:
			return nil
		}
		state[key] = 1
		seen := make(map[string]bool)
		for _, dep := range node.DependsOn {
			if seen[dep] {
				return fmt.Errorf("duplicate prerequisite %q in node %q", dep, key)
			}
			seen[dep] = true
			if err := visit(dep); err != nil {
				return err
			}
		}
		state[key] = 2
		ordered = append(ordered, node)
		return nil
	}
	if err := visit(req.Integration); err != nil {
		return nil, err
	}
	if len(ordered) != len(nodes) {
		return nil, fmt.Errorf("every Work graph node must lead to the integration item")
	}
	return ordered, nil
}

func (s *Server) handleSDKWorkGraph(w http.ResponseWriter, r *http.Request) {
	var req workGraphFiling
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&req) != nil || strings.TrimSpace(req.ClientRef) == "" || len(req.ClientRef) > 256 ||
		(req.ProjectIDs != nil && len(*req.ProjectIDs) > 32) || len(req.Nodes) < 2 || len(req.Nodes) > 12 || len(req.Source) > 4096 {
		http.Error(w, "Work graph requires a clientRef and 2 to 12 nodes", http.StatusBadRequest)
		return
	}
	ordered, err := workGraphOrder(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	request, _ := json.Marshal(req)
	hash := fmt.Sprintf("%x", sha256.Sum256(request))
	h := s.sdkChats
	h.mu.Lock()
	defer h.mu.Unlock()
	creator := h.requestWorkActorLocked(r)
	identity, _ := json.Marshal([]any{creator, req.ClientRef})
	graphID := fmt.Sprintf("%x", sha256.Sum256(identity))
	path := filepath.Join(h.workGraphDir(), graphID+".json")
	if receipt, err := readWorkGraph(path); err == nil {
		if receipt.Hash != hash {
			http.Error(w, "clientRef already used for a different Work graph", http.StatusConflict)
			return
		}
		writeSDKJSON(w, http.StatusOK, h.workGraphResponseLocked(receipt))
		return
	} else if !os.IsNotExist(err) {
		http.Error(w, "could not read existing Work graph", http.StatusInternalServerError)
		return
	}
	projects := []string{}
	if req.ProjectIDs != nil {
		projects = normalizeWorkProjectIDs(*req.ProjectIDs)
	} else if creator.Kind == "chat" {
		if chat := h.chats[creator.SessionID]; chat != nil && chat.WorkspaceID != "" {
			projects = []string{chat.WorkspaceID}
		}
	}
	for _, project := range projects {
		if h.projects[project] == nil {
			http.Error(w, "unknown project folder: "+project, http.StatusUnprocessableEntity)
			return
		}
	}
	receipt := workGraphReceipt{Hash: hash}
	ids := make(map[string]string)
	firstRef, _ := workReferenceNumber(h.nextWorkReferenceLocked())
	if firstRef == 0 || ^uint64(0)-firstRef < uint64(len(ordered)-1) {
		http.Error(w, "Work reference space exhausted", http.StatusInsufficientStorage)
		return
	}
	now := time.Now().UTC()
	for i, node := range ordered {
		if err := validWorkSteps(node.Plan, true); err != nil {
			http.Error(w, fmt.Sprintf("%s: %s", node.Key, err), http.StatusUnprocessableEntity)
			return
		}
		protocol := strings.TrimSpace(node.PlanProtocol)
		if len(node.Plan) == 0 || protocol == "" || len(protocol) > 2048 {
			http.Error(w, fmt.Sprintf("%s: a plan and plan protocol are required", node.Key), http.StatusUnprocessableEntity)
			return
		}
		goal := strings.TrimSpace(node.Goal)
		check := checkWorkGoal(goal, 1)
		if goal == "" || !check.Passed {
			writeSDKJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "revise the node goal before retrying filing", "node": node.Key, "goalCheck": check})
			return
		}
		deps := make([]string, 0, len(node.DependsOn))
		for _, key := range node.DependsOn {
			deps = append(deps, ids[key])
		}
		id := sdkID()
		ids[node.Key] = id
		item := &sdkWorkItem{
			ID: id, Reference: fmt.Sprintf("Work #%d", firstRef+uint64(i)), GraphID: graphID,
			Title: node.Title, Brief: node.Brief, Acceptance: node.Acceptance, NextAction: node.NextAction,
			Source: strings.TrimSpace(req.Source), Status: "open", Readiness: "ready", CreatedBy: creator,
			ProjectIDs: projects, DependsOn: deps, UIWork: node.UIWork, GoalCondition: goal,
			GoalRevision: 1, GoalFiledRevision: 1, GoalCheck: &check, ReviewVersion: 1,
			Plan: node.Plan, PlanProtocol: protocol, PlanRevision: 1, Revision: 1,
			CreatedAt: now, UpdatedAt: now, Updates: []sdkWorkUpdate{},
		}
		receipt.Items = append(receipt.Items, item)
	}
	for _, item := range receipt.Items {
		item.GraphIntegrationID = ids[req.Integration]
	}
	if h.updateUntil.Load() > time.Now().UnixNano() {
		http.Error(w, "Muxterm is preparing an automatic update; retry the Work change shortly", http.StatusServiceUnavailable)
		return
	}
	data, err := json.Marshal(receipt)
	if err == nil {
		err = os.MkdirAll(h.workGraphDir(), 0700)
	}
	if err == nil {
		err = atomicfile.Write(path, data, 0600)
	}
	if err != nil {
		http.Error(w, "could not save Work graph: "+err.Error(), http.StatusInternalServerError)
		return
	}
	for _, item := range receipt.Items {
		h.workItems[item.ID] = item
	}
	if h.onWorkChange != nil {
		h.onWorkChange()
	}
	s.wakeWork()
	writeSDKJSON(w, http.StatusCreated, h.workGraphResponseLocked(receipt))
}

func (h *sdkChatHost) workGraphResponseLocked(receipt workGraphReceipt) map[string]any {
	items := make([]sdkWorkItem, 0, len(receipt.Items))
	for _, filed := range receipt.Items {
		item := *h.workItems[filed.ID]
		item.WaitingOn = h.workWaitingOnLocked(&item)
		items = append(items, item)
	}
	return map[string]any{"work": items, "integrationId": items[len(items)-1].ID}
}

func (h *sdkChatHost) workGraphLinksLocked(item *sdkWorkItem) []string {
	if item.GraphID == "" {
		return nil
	}
	var ids []string
	for _, other := range h.workItems {
		if other.ID != item.ID && other.GraphID == item.GraphID {
			ids = append(ids, other.ID)
		}
	}
	slices.Sort(ids)
	return ids
}
