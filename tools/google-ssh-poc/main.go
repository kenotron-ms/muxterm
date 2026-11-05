package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

type app struct {
	ctx          context.Context
	config       *oauth2.Config
	state        string
	verifier     string
	output       string
	callbackPort uint32
	simulate     bool
	done         chan struct{}
	mu           sync.Mutex
	claimed      bool
	consumed     bool
}

func randomValue() string {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic("random source unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(bytes[:])
}

func privateWrite(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	return errors.Join(writeErr, closeErr)
}

func loadConfig(path, redirect string) (*oauth2.Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("cannot load credential file")
	}
	var document struct {
		Installed struct {
			ClientID string `json:"client_id"`
		} `json:"installed"`
	}
	if json.Unmarshal(data, &document) != nil || document.Installed.ClientID == "" {
		return nil, errors.New("credential file must contain a Desktop app client")
	}
	config, err := google.ConfigFromJSON(data, "https://www.googleapis.com/auth/gmail.readonly")
	if err != nil {
		return nil, errors.New("cannot parse desktop credentials")
	}
	config.RedirectURL = redirect
	return config, nil
}

func verifyGoogle(ctx context.Context, config *oauth2.Config, token *oauth2.Token) (*oauth2.Token, int, error) {
	if token.RefreshToken == "" {
		return nil, 0, errors.New("no refresh token received; reconnect with consent")
	}
	expired := *token
	expired.AccessToken = ""
	expired.Expiry = time.Now().Add(-time.Hour)
	refreshed, err := config.TokenSource(ctx, &expired).Token()
	if err != nil {
		return nil, 0, errors.New("Google refresh failed")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://gmail.googleapis.com/gmail/v1/users/me/labels", nil)
	if err != nil {
		return nil, 0, errors.New("cannot construct Gmail request")
	}
	response, err := config.Client(ctx, refreshed).Do(request)
	if err != nil {
		return nil, 0, errors.New("Gmail request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("Gmail returned HTTP %d", response.StatusCode)
	}
	var result struct {
		Labels []json.RawMessage `json:"labels"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result) != nil {
		return nil, 0, errors.New("cannot parse Gmail response")
	}
	return refreshed, len(result.Labels), nil
}

func (application *app) callback(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'")
	if request.Method != http.MethodGet || request.URL.Path != "/callback" {
		http.Error(writer, "Not found", http.StatusNotFound)
		return
	}
	if subtle.ConstantTimeCompare([]byte(request.URL.Query().Get("state")), []byte(application.state)) != 1 {
		http.Error(writer, "Invalid connection state", http.StatusForbidden)
		return
	}
	application.mu.Lock()
	if application.consumed || application.ctx.Err() != nil {
		application.mu.Unlock()
		http.Error(writer, "Connection expired or already used", http.StatusGone)
		return
	}
	if request.URL.Query().Get("code") == "" && request.URL.Query().Get("error") == "" {
		application.mu.Unlock()
		http.Error(writer, "Missing authorization code", http.StatusBadRequest)
		return
	}
	application.consumed = true
	application.mu.Unlock()
	defer close(application.done)
	if request.URL.Query().Get("error") != "" {
		log.Print("Google consent was denied")
		http.Error(writer, "Google consent was denied", http.StatusBadRequest)
		return
	}
	if application.simulate {
		if request.URL.Query().Get("code") != "transport-only" {
			http.Error(writer, "Invalid simulated code", http.StatusBadRequest)
			return
		}
		log.Print("PASS: browser callback reached container through SSH; Google was NOT contacted")
		fmt.Fprint(writer, "SSH callback transport verified. This was a simulation; Google is NOT connected.")
		return
	}
	ctx, cancel := context.WithTimeout(application.ctx, 45*time.Second)
	defer cancel()
	token, err := application.config.Exchange(ctx, request.URL.Query().Get("code"), oauth2.VerifierOption(application.verifier))
	if err != nil {
		log.Print("Google code exchange failed (details suppressed)")
		http.Error(writer, "Google code exchange failed", http.StatusBadGateway)
		return
	}
	token, count, err := verifyGoogle(ctx, application.config, token)
	if err != nil {
		log.Print(err)
		http.Error(writer, err.Error(), http.StatusBadGateway)
		return
	}
	data, err := json.Marshal(token)
	if err != nil || privateWrite(filepath.Join(application.output, "token.json"), data) != nil {
		log.Print("Cannot persist authorization")
		http.Error(writer, "Cannot persist authorization", http.StatusInternalServerError)
		return
	}
	log.Printf("PASS: Google code exchange, forced refresh, and Gmail label read succeeded (%d labels); no message contents read", count)
	fmt.Fprint(writer, "Google connected. Refresh and read-only Gmail access verified. You can close SSH.")
}

func (application *app) authorizationURL() string {
	if application.simulate {
		return fmt.Sprintf("http://127.0.0.1:%d/callback?code=transport-only&state=%s", application.callbackPort, application.state)
	}
	return application.config.AuthCodeURL(application.state, oauth2.AccessTypeOffline, oauth2.SetAuthURLParam("prompt", "consent"), oauth2.S256ChallengeOption(application.verifier))
}

func (application *app) session(incoming ssh.NewChannel) {
	channel, requests, err := incoming.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	for request := range requests {
		accepted := request.Type == "exec" && string(request.Payload) == string(ssh.Marshal(struct{ Command string }{"connect"}))
		if request.WantReply {
			_ = request.Reply(accepted, nil)
		}
		if !accepted {
			continue
		}
		fmt.Fprintln(channel, "Open this link in the browser on the computer running this SSH command:")
		fmt.Fprintln(channel, application.authorizationURL())
		select {
		case <-application.done:
		case <-application.ctx.Done():
		}
		_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
		return
	}
}

func (application *app) forward(incoming ssh.NewChannel) {
	var destination struct {
		Host       string
		Port       uint32
		Origin     string
		OriginPort uint32
	}
	if ssh.Unmarshal(incoming.ExtraData(), &destination) != nil || destination.Host != "127.0.0.1" || destination.Port != application.callbackPort {
		_ = incoming.Reject(ssh.Prohibited, "Only the OAuth callback destination is allowed")
		return
	}
	connection, err := net.DialTimeout("tcp", net.JoinHostPort(destination.Host, strconv.Itoa(int(destination.Port))), 3*time.Second)
	if err != nil {
		_ = incoming.Reject(ssh.ConnectionFailed, "Callback unavailable")
		return
	}
	defer connection.Close()
	channel, requests, err := incoming.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	go ssh.DiscardRequests(requests)
	finished := make(chan struct{})
	go func() {
		_, _ = io.Copy(connection, channel)
		_ = connection.(*net.TCPConn).CloseWrite()
		close(finished)
	}()
	_, _ = io.Copy(channel, connection)
	_ = channel.Close()
	_ = connection.Close()
	<-finished
}

func (application *app) serveSSH(connection net.Conn, config *ssh.ServerConfig) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(15 * time.Second))
	server, channels, requests, err := ssh.NewServerConn(connection, config)
	if err != nil {
		return
	}
	_ = connection.SetDeadline(time.Time{})
	defer server.Close()
	application.mu.Lock()
	if application.claimed {
		application.mu.Unlock()
		return
	}
	application.claimed = true
	application.mu.Unlock()
	go ssh.DiscardRequests(requests)
	go func() { <-application.ctx.Done(); _ = server.Close() }()
	for incoming := range channels {
		switch incoming.ChannelType() {
		case "direct-tcpip":
			go application.forward(incoming)
		case "session":
			go application.session(incoming)
		default:
			_ = incoming.Reject(ssh.Prohibited, "Channel type prohibited")
		}
	}
}

func run() error {
	credentials := flag.String("credentials", "", "Desktop OAuth client JSON, loaded only by the program")
	output := flag.String("output", "/data", "Private runtime and token directory")
	simulate := flag.Bool("simulate", false, "Exercise callback transport WITHOUT Google or credentials")
	verify := flag.Bool("verify", false, "Refresh saved authorization and read Gmail with no SSH listener")
	sshAddress := flag.String("ssh", "0.0.0.0:22213", "Container SSH bind address")
	callbackPort := flag.Uint("callback-port", 18765, "Loopback callback port")
	ttl := flag.Duration("ttl", 10*time.Minute, "Connection attempt lifetime")
	flag.Parse()
	if *callbackPort == 0 || *callbackPort > 65535 || *ttl <= 0 || *ttl > 30*time.Minute {
		return errors.New("invalid port or TTL")
	}
	if err := os.MkdirAll(*output, 0700); err != nil {
		return errors.New("cannot create private output directory")
	}
	if err := os.Chmod(*output, 0700); err != nil {
		return errors.New("cannot protect output directory")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, *ttl)
	defer cancel()
	ctx = context.WithValue(ctx, oauth2.HTTPClient, &http.Client{Timeout: 30 * time.Second})
	application := &app{ctx: ctx, state: randomValue(), verifier: oauth2.GenerateVerifier(), output: *output, callbackPort: uint32(*callbackPort), simulate: *simulate, done: make(chan struct{})}
	if !*simulate {
		var err error
		application.config, err = loadConfig(*credentials, fmt.Sprintf("http://127.0.0.1:%d/callback", *callbackPort))
		if err != nil {
			return err
		}
	}
	if *verify {
		if *simulate {
			return errors.New("verify requires real Google credentials")
		}
		data, err := os.ReadFile(filepath.Join(*output, "token.json"))
		if err != nil {
			return errors.New("saved token unavailable")
		}
		var token oauth2.Token
		if json.Unmarshal(data, &token) != nil {
			return errors.New("saved token invalid")
		}
		_, count, err := verifyGoogle(ctx, application.config, &token)
		if err != nil {
			return err
		}
		log.Printf("PASS: without SSH, forced refresh and Gmail read succeeded (%d labels)", count)
		return nil
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return errors.New("cannot generate host key")
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		return errors.New("cannot create host signer")
	}
	password := randomValue()
	if privateWrite(filepath.Join(*output, "pairing-password"), []byte(password+"\n")) != nil {
		return errors.New("use a fresh output directory for each connection attempt")
	}
	defer os.Remove(filepath.Join(*output, "pairing-password"))
	if privateWrite(filepath.Join(*output, "host-key.pub"), ssh.MarshalAuthorizedKey(signer.PublicKey())) != nil {
		return errors.New("cannot write public host key")
	}
	config := &ssh.ServerConfig{MaxAuthTries: 3, PasswordCallback: func(metadata ssh.ConnMetadata, supplied []byte) (*ssh.Permissions, error) {
		if metadata.User() != "connect" || subtle.ConstantTimeCompare(supplied, []byte(password)) != 1 {
			return nil, errors.New("authentication denied")
		}
		return &ssh.Permissions{}, nil
	}}
	config.AddHostKey(signer)
	callbackListener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *callbackPort))
	if err != nil {
		return errors.New("cannot bind container callback")
	}
	server := &http.Server{Handler: http.HandlerFunc(application.callback), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 5 * time.Second}
	go server.Serve(callbackListener)
	defer server.Close()
	listener, err := net.Listen("tcp", *sshAddress)
	if err != nil {
		return errors.New("cannot bind container SSH endpoint")
	}
	defer listener.Close()
	log.Printf("READY: temporary SSH endpoint; fingerprint %s; expires in %s; simulation=%t", ssh.FingerprintSHA256(signer.PublicKey()), *ttl, *simulate)
	go func() {
		select {
		case <-application.done:
			time.Sleep(2 * time.Second)
		case <-ctx.Done():
		}
		cancel()
		_ = listener.Close()
	}()
	for {
		connection, err := listener.Accept()
		if err != nil {
			break
		}
		application.mu.Lock()
		claimed := application.claimed
		application.mu.Unlock()
		if claimed {
			_ = connection.Close()
			continue
		}
		go application.serveSSH(connection, config)
	}
	log.Print("Temporary SSH endpoint closed")
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
