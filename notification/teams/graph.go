package teams

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/target/goalert/config"
)

// Graph API resource types used by this package.
const (
	odataCall               = "#microsoft.graph.call"
	odataPlayPromptOp       = "#microsoft.graph.playPromptOperation"
	odataIdentitySet        = "#microsoft.graph.identitySet"
	odataIdentity           = "#microsoft.graph.identity"
	odataParticipantInfo    = "#microsoft.graph.participantInfo"
	odataInvitationInfo     = "#microsoft.graph.invitationParticipantInfo"
	odataServiceHostedMedia = "#microsoft.graph.serviceHostedMediaConfig"
	odataMediaInfo          = "#microsoft.graph.mediaInfo"
	odataMediaPrompt        = "#microsoft.graph.mediaPrompt"
)

// Call states returned by Microsoft Graph.
const (
	CallStateEstablishing = "establishing"
	CallStateRinging      = "ringing"
	CallStateEstablished  = "established"
	CallStateTerminated   = "terminated"
)

// GraphError is returned for non-2xx responses from Microsoft Graph.
type GraphError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *GraphError) Error() string {
	return fmt.Sprintf("microsoft graph: HTTP %d: %s: %s", e.StatusCode, e.Code, e.Message)
}

// IsNotFound returns true if the error is a 404 from Microsoft Graph.
func IsNotFound(err error) bool {
	var g *GraphError
	return errors.As(err, &g) && g.StatusCode == http.StatusNotFound
}

type identity struct {
	ODataType   string `json:"@odata.type,omitempty"`
	ID          string `json:"id,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
}

type identitySet struct {
	ODataType   string    `json:"@odata.type,omitempty"`
	Application *identity `json:"application,omitempty"`
	User        *identity `json:"user,omitempty"`
}

type participantInfo struct {
	ODataType string      `json:"@odata.type,omitempty"`
	Identity  identitySet `json:"identity"`
}

type mediaInfo struct {
	ODataType  string `json:"@odata.type,omitempty"`
	URI        string `json:"uri"`
	ResourceID string `json:"resourceId,omitempty"`
}

type mediaConfig struct {
	ODataType     string      `json:"@odata.type"`
	PreFetchMedia []mediaInfo `json:"preFetchMedia,omitempty"`
}

// ResultInfo describes why a call was terminated.
type ResultInfo struct {
	Code    int    `json:"code"`
	Subcode int    `json:"subcode"`
	Message string `json:"message"`
}

// ToneInfo describes a DTMF tone pressed by the callee.
type ToneInfo struct {
	SequenceID int64  `json:"sequenceId"`
	Tone       string `json:"tone"`
}

// Call is the subset of the Microsoft Graph call resource used by GoAlert.
type Call struct {
	ID         string      `json:"id,omitempty"`
	State      string      `json:"state,omitempty"`
	Direction  string      `json:"direction,omitempty"`
	ResultInfo *ResultInfo `json:"resultInfo,omitempty"`
	ToneInfo   *ToneInfo   `json:"toneInfo,omitempty"`
}

type createCallRequest struct {
	ODataType           string            `json:"@odata.type"`
	CallbackURI         string            `json:"callbackUri"`
	Source              participantInfo   `json:"source"`
	Targets             []participantInfo `json:"targets"`
	RequestedModalities []string          `json:"requestedModalities"`
	MediaConfig         mediaConfig       `json:"mediaConfig"`
	TenantID            string            `json:"tenantId"`
}

type mediaPrompt struct {
	ODataType string    `json:"@odata.type"`
	MediaInfo mediaInfo `json:"mediaInfo"`
}

type playPromptRequest struct {
	ClientContext string        `json:"clientContext"`
	Prompts       []mediaPrompt `json:"prompts"`
}

type clientContextRequest struct {
	ClientContext string `json:"clientContext"`
}

// PlayPromptOperation is the subset of the playPromptOperation resource used by GoAlert.
type PlayPromptOperation struct {
	ID            string      `json:"id,omitempty"`
	Status        string      `json:"status,omitempty"`
	ClientContext string      `json:"clientContext,omitempty"`
	ResultInfo    *ResultInfo `json:"resultInfo,omitempty"`
}

type graphUser struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

func (c *Config) graphDo(ctx context.Context, method, path string, body, out interface{}) error {
	var rdr io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.graphBaseURL()+path, rdr)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")

	tok, err := c.tokenSource(ctx).Token()
	if err != nil {
		return fmt.Errorf("get graph access token: %w", err)
	}
	tok.SetAuthHeader(req)

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		gErr := &GraphError{StatusCode: resp.StatusCode}
		var errResp struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &errResp) == nil && errResp.Error.Code != "" {
			gErr.Code = errResp.Error.Code
			gErr.Message = errResp.Error.Message
		} else {
			gErr.Message = strings.TrimSpace(string(data))
		}
		return gErr
	}

	if out == nil || len(data) == 0 {
		return nil
	}

	return json.Unmarshal(data, out)
}

// CreateCall places a new outbound audio call to the given Entra user (object ID).
//
// The callbackURI receives call notifications, and promptURL is pre-fetched by
// the service-hosted media stack so it can be played as soon as the call connects.
func (c *Config) CreateCall(ctx context.Context, userID, callbackURI, promptURL string) (*Call, error) {
	cfg := config.FromContext(ctx)

	displayName := cfg.Teams.DisplayName
	if displayName == "" {
		displayName = cfg.ApplicationName()
	}

	req := createCallRequest{
		ODataType:   odataCall,
		CallbackURI: callbackURI,
		Source: participantInfo{
			ODataType: odataParticipantInfo,
			Identity: identitySet{
				ODataType:   odataIdentitySet,
				Application: &identity{ODataType: odataIdentity, ID: cfg.Teams.ClientID, DisplayName: displayName},
			},
		},
		Targets: []participantInfo{{
			ODataType: odataInvitationInfo,
			Identity: identitySet{
				ODataType: odataIdentitySet,
				User:      &identity{ODataType: odataIdentity, ID: userID},
			},
		}},
		RequestedModalities: []string{"audio"},
		MediaConfig: mediaConfig{
			ODataType:     odataServiceHostedMedia,
			PreFetchMedia: []mediaInfo{{ODataType: odataMediaInfo, URI: promptURL, ResourceID: uuid.NewString()}},
		},
		TenantID: cfg.Teams.TenantID,
	}

	var call Call
	err := c.graphDo(ctx, http.MethodPost, "/communications/calls", req, &call)
	if err != nil {
		return nil, err
	}
	if call.ID == "" {
		return nil, errors.New("microsoft graph: create call returned no call id")
	}

	return &call, nil
}

// GetCall fetches the current state of a call.
func (c *Config) GetCall(ctx context.Context, callID string) (*Call, error) {
	var call Call
	err := c.graphDo(ctx, http.MethodGet, "/communications/calls/"+url.PathEscape(callID), nil, &call)
	if err != nil {
		return nil, err
	}
	return &call, nil
}

// HangUp terminates a call. A missing (already ended) call is not an error.
func (c *Config) HangUp(ctx context.Context, callID string) error {
	err := c.graphDo(ctx, http.MethodDelete, "/communications/calls/"+url.PathEscape(callID), nil, nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// PlayPrompt plays the audio at promptURL to the callee. The clientContext is
// echoed back in the playPromptOperation notification.
func (c *Config) PlayPrompt(ctx context.Context, callID, clientContext, promptURL string) (*PlayPromptOperation, error) {
	req := playPromptRequest{
		ClientContext: clientContext,
		Prompts: []mediaPrompt{{
			ODataType: odataMediaPrompt,
			MediaInfo: mediaInfo{ODataType: odataMediaInfo, URI: promptURL, ResourceID: uuid.NewString()},
		}},
	}

	var op PlayPromptOperation
	err := c.graphDo(ctx, http.MethodPost, "/communications/calls/"+url.PathEscape(callID)+"/playPrompt", req, &op)
	if err != nil {
		return nil, err
	}
	return &op, nil
}

// CancelMediaProcessing stops any prompt that is currently playing.
func (c *Config) CancelMediaProcessing(ctx context.Context, callID string) error {
	return c.graphDo(ctx, http.MethodPost, "/communications/calls/"+url.PathEscape(callID)+"/cancelMediaProcessing", clientContextRequest{ClientContext: uuid.NewString()}, nil)
}

// SubscribeToTone requests DTMF tone notifications for the call.
func (c *Config) SubscribeToTone(ctx context.Context, callID string) error {
	return c.graphDo(ctx, http.MethodPost, "/communications/calls/"+url.PathEscape(callID)+"/subscribeToTone", clientContextRequest{ClientContext: uuid.NewString()}, nil)
}

type cachedUser struct {
	id      string
	expires time.Time
}

var (
	userCacheMx sync.Mutex
	userCache   = make(map[string]cachedUser)
)

const userCacheTTL = 15 * time.Minute

// ResolveUserID returns the Entra object ID for a user reference, which may be
// an object ID already or a user principal name (email address).
func (c *Config) ResolveUserID(ctx context.Context, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if _, err := uuid.Parse(ref); err == nil {
		return ref, nil
	}

	userCacheMx.Lock()
	cached, ok := userCache[ref]
	userCacheMx.Unlock()
	if ok && time.Now().Before(cached.expires) {
		return cached.id, nil
	}

	var u graphUser
	err := c.graphDo(ctx, http.MethodGet, "/users/"+url.PathEscape(ref)+"?$select=id,displayName", nil, &u)
	if err != nil {
		return "", err
	}
	if u.ID == "" {
		return "", fmt.Errorf("microsoft graph: no id returned for user '%s'", ref)
	}

	userCacheMx.Lock()
	userCache[ref] = cachedUser{id: u.ID, expires: time.Now().Add(userCacheTTL)}
	userCacheMx.Unlock()

	return u.ID, nil
}
