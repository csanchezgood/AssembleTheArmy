package teams

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/target/goalert/config"
)

// Microsoft signs call notifications with Bot Framework tokens.
//
// https://learn.microsoft.com/en-us/graph/api/resources/communications-api-overview
const (
	botFrameworkIssuer        = "https://api.botframework.com"
	botFrameworkOpenIDConfURL = "https://api.aps.skype.com/v1/.well-known/OpenIdConfiguration"
)

// A NotificationVerifier authenticates incoming call notifications.
type NotificationVerifier interface {
	Verify(ctx context.Context, req *http.Request) error
}

// NotificationVerifierFunc adapts a function to the NotificationVerifier interface.
type NotificationVerifierFunc func(ctx context.Context, req *http.Request) error

// Verify implements NotificationVerifier.
func (f NotificationVerifierFunc) Verify(ctx context.Context, req *http.Request) error {
	return f(ctx, req)
}

// BotFrameworkVerifier validates the bearer token Microsoft sends with each
// call notification: it must be signed by Bot Framework and be intended for the
// configured Teams application (client) ID.
type BotFrameworkVerifier struct {
	// OpenIDConfigURL overrides the Bot Framework OpenID configuration document URL.
	OpenIDConfigURL string
	Client          *http.Client

	once    sync.Once
	keySet  oidc.KeySet
	initErr error
}

func (v *BotFrameworkVerifier) client() *http.Client {
	if v.Client != nil {
		return v.Client
	}
	return http.DefaultClient
}

func (v *BotFrameworkVerifier) init() {
	confURL := v.OpenIDConfigURL
	if confURL == "" {
		confURL = botFrameworkOpenIDConfURL
	}

	resp, err := v.client().Get(confURL)
	if err != nil {
		v.initErr = fmt.Errorf("fetch bot framework openid configuration: %w", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		v.initErr = fmt.Errorf("fetch bot framework openid configuration: HTTP %d", resp.StatusCode)
		return
	}

	var conf struct {
		JWKSURI string `json:"jwks_uri"`
	}
	err = json.NewDecoder(resp.Body).Decode(&conf)
	if err != nil {
		v.initErr = fmt.Errorf("parse bot framework openid configuration: %w", err)
		return
	}
	if conf.JWKSURI == "" {
		v.initErr = errors.New("bot framework openid configuration has no jwks_uri")
		return
	}

	// The key set caches keys and refreshes them on unknown key IDs, so it
	// needs a context that outlives any single request.
	v.keySet = oidc.NewRemoteKeySet(oidc.ClientContext(context.Background(), v.client()), conf.JWKSURI)
}

// Verify implements NotificationVerifier.
func (v *BotFrameworkVerifier) Verify(ctx context.Context, req *http.Request) error {
	rawToken, ok := strings.CutPrefix(req.Header.Get("Authorization"), "Bearer ")
	if !ok || rawToken == "" {
		return errors.New("missing bearer token")
	}

	v.once.Do(v.init)
	if v.initErr != nil {
		// allow a retry on the next request
		v.once = sync.Once{}
		return v.initErr
	}

	cfg := config.FromContext(ctx)
	verifier := oidc.NewVerifier(botFrameworkIssuer, v.keySet, &oidc.Config{
		ClientID:             cfg.Teams.ClientID,
		SupportedSigningAlgs: []string{oidc.RS256},
	})

	_, err := verifier.Verify(ctx, rawToken)
	if err != nil {
		return fmt.Errorf("verify notification token: %w", err)
	}

	return nil
}
