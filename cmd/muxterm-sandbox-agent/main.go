// muxterm-sandbox-agent connects a private sessiond to its enrolled HTTPS broker.
package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/kenotron-ms/muxterm/internal/transport/relay"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

func main() {
	config := flag.String("config", "", "private worker-only relay JSON file")
	socket := flag.String("socket", "", "absolute private sessiond Unix socket")
	flag.Parse()
	if err := run(*config, *socket); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(path, socket string) error {
	if !filepath.IsAbs(socket) {
		return fmt.Errorf("absolute private sessiond socket required")
	}
	st, err := os.Stat(socket)
	if err != nil || st.Mode()&os.ModeSocket == 0 || st.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("sessiond socket must exist and be private")
	}
	cfg, err := relay.LoadConfig(path)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	return relay.RunWorker(ctx, cfg, socket)
}
