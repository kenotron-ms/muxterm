// chat-attachments-proof runs the attachment routes without starting muxterm,
// sessiond, a chat sidecar, or any production service. It is for HTTP proof.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/chatattachments"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8453", "isolated listen address")
	rootFlag := flag.String("root", "", "absolute attachment data root")
	resolve := flag.String("resolve", "", "resolve an ID and exit")
	flag.Parse()
	root := *rootFlag
	if root == "" {
		var err error
		root, err = chatattachments.DefaultRoot()
		if err != nil {
			log.Fatal(err)
		}
	}
	store, err := chatattachments.NewStore(root)
	if err != nil {
		log.Fatal(err)
	}
	if *resolve != "" {
		path, item, err := store.ResolvePath(*resolve)
		if err != nil {
			log.Fatal(err)
		}
		out := struct {
			Path string `json:"path"`
			chatattachments.Attachment
		}{Path: path, Attachment: item}
		if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *addr != "127.0.0.1:8453" {
		log.Fatal("proof listener is restricted to 127.0.0.1:8453")
	}
	token := os.Getenv("MUXTERM_ATTACHMENT_PROOF_TOKEN")
	if token == "" {
		log.Fatal("MUXTERM_ATTACHMENT_PROOF_TOKEN is required")
	}
	protect := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+token {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" && !strings.EqualFold(origin, "http://"+r.Host) {
				http.Error(w, "cross-origin request", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
	mux := http.NewServeMux()
	if err := chatattachments.RegisterRoutes(mux, store, protect); err != nil {
		log.Fatal(err)
	}
	fmt.Fprintf(os.Stderr, "attachment proof listening on %s, root %s\n", *addr, root)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
