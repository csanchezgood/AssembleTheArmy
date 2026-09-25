package teams

import (
	"context"
	"net/http"
	"strings"
	"sync"

	"github.com/target/goalert/config"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/clientcredentials"
)

const (
	defaultGraphBaseURL = "https://graph.microsoft.com/v1.0"
	defaultLoginBaseURL = "https://login.microsoftonline.com"
	graphScope          = "https://graph.microsoft.com/.default"
)

// Config contains values used for the Microsoft Teams calling provider.
//
// Calls are placed with the Microsoft Graph cloud communications API and the
// spoken message is generated with Azure AI Speech (text-to-speech).
type Config struct {
	// GraphBaseURL overrides the Microsoft Graph endpoint (mainly for tests).
	GraphBaseURL string

	// LoginBaseURL overrides the Microsoft identity platform endpoint (mainly for tests).
	LoginBaseURL string

	// SpeechBaseURL overrides the Azure AI Speech endpoint. When empty, the
	// regional endpoint for Teams.SpeechRegion is used.
	SpeechBaseURL string

	// Verifier validates incoming notification callbacks from Microsoft.
	// When nil, a verifier for Bot Framework tokens is used.
	Verifier NotificationVerifier

	Client *http.Client

	mx       sync.Mutex
	tokenKey string
	tokenSrc oauth2.TokenSource
}

func (c *Config) httpClient() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return http.DefaultClient
}

func (c *Config) graphBaseURL() string {
	if c.GraphBaseURL != "" {
		return strings.TrimSuffix(c.GraphBaseURL, "/")
	}
	return defaultGraphBaseURL
}

func (c *Config) loginBaseURL() string {
	if c.LoginBaseURL != "" {
		return strings.TrimSuffix(c.LoginBaseURL, "/")
	}
	return defaultLoginBaseURL
}

// tokenSource returns a cached OAuth2 client-credentials token source for the
// tenant/app currently configured. It is re-created when config values change.
func (c *Config) tokenSource(ctx context.Context) oauth2.TokenSource {
	cfg := config.FromContext(ctx)
	key := strings.Join([]string{cfg.Teams.TenantID, cfg.Teams.ClientID, cfg.Teams.ClientSecret, c.loginBaseURL()}, "\x00")

	c.mx.Lock()
	defer c.mx.Unlock()
	if c.tokenSrc != nil && c.tokenKey == key {
		return c.tokenSrc
	}

	cc := &clientcredentials.Config{
		ClientID:     cfg.Teams.ClientID,
		ClientSecret: cfg.Teams.ClientSecret,
		TokenURL:     c.loginBaseURL() + "/" + cfg.Teams.TenantID + "/oauth2/v2.0/token",
		Scopes:       []string{graphScope},
		// Microsoft's documented client-credentials flow sends the credentials in the form body.
		AuthStyle: oauth2.AuthStyleInParams,
	}

	// A background context is used so the cached token source outlives the request.
	tokenCtx := context.WithValue(context.Background(), oauth2.HTTPClient, c.httpClient())
	c.tokenSrc = cc.TokenSource(tokenCtx)
	c.tokenKey = key

	return c.tokenSrc
}
