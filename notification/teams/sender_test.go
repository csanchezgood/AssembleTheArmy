package teams

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/target/goalert/auth/authlink"
	"github.com/target/goalert/config"
	"github.com/target/goalert/gadb"
	"github.com/target/goalert/notification"
	"github.com/target/goalert/notification/nfymsg"
)

// fakeGraph is a minimal Microsoft Graph / identity / speech stand-in.
type fakeGraph struct {
	t   *testing.T
	srv *httptest.Server

	mx       sync.Mutex
	requests []fakeRequest
}

type fakeRequest struct {
	Method string
	Path   string
	Body   map[string]interface{}
}

func newFakeGraph(t *testing.T) *fakeGraph {
	f := &fakeGraph{t: t}
	mux := http.NewServeMux()

	mux.HandleFunc("POST /tenant-id/oauth2/v2.0/token", func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		assert.Equal(t, "client-id", r.Form.Get("client_id"))
		assert.Equal(t, "client-secret", r.Form.Get("client_secret"))
		assert.Equal(t, graphScope, r.Form.Get("scope"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"tok","token_type":"Bearer","expires_in":3600}`)
	})

	mux.HandleFunc("/cognitiveservices/v1", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "speech-key", r.Header.Get("Ocp-Apim-Subscription-Key"))
		assert.Equal(t, speechOutputFormat, r.Header.Get("X-Microsoft-OutputFormat"))
		data, _ := io.ReadAll(r.Body)
		f.record(r, map[string]interface{}{"ssml": string(data)})
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = io.WriteString(w, "RIFF-fake-wav")
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer tok", r.Header.Get("Authorization"))
		var body map[string]interface{}
		if r.Body != nil {
			data, _ := io.ReadAll(r.Body)
			if len(data) > 0 {
				require.NoError(t, json.Unmarshal(data, &body))
			}
		}
		f.record(r, body)
		w.Header().Set("Content-Type", "application/json")

		switch {
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/users/"):
			if strings.Contains(r.URL.Path, "missing@") {
				w.WriteHeader(404)
				_, _ = io.WriteString(w, `{"error":{"code":"Request_ResourceNotFound","message":"user not found"}}`)
				return
			}
			_, _ = io.WriteString(w, `{"id":"11111111-1111-1111-1111-111111111111","displayName":"Bob"}`)
		case r.Method == "POST" && r.URL.Path == "/communications/calls":
			w.WriteHeader(201)
			_, _ = io.WriteString(w, `{"id":"call-1","state":"establishing"}`)
		case r.Method == "GET" && r.URL.Path == "/communications/calls/call-1":
			_, _ = io.WriteString(w, `{"id":"call-1","state":"established"}`)
		case r.Method == "GET" && r.URL.Path == "/communications/calls/gone":
			w.WriteHeader(404)
			_, _ = io.WriteString(w, `{"error":{"code":"ItemNotFound","message":"call not found"}}`)
		case r.Method == "DELETE":
			w.WriteHeader(204)
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/playPrompt"):
			_, _ = io.WriteString(w, `{"id":"op-1","status":"running","clientContext":"`+body["clientContext"].(string)+`"}`)
		case r.Method == "POST":
			w.WriteHeader(202)
		default:
			w.WriteHeader(404)
		}
	})

	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGraph) record(r *http.Request, body map[string]interface{}) {
	f.mx.Lock()
	defer f.mx.Unlock()
	f.requests = append(f.requests, fakeRequest{Method: r.Method, Path: r.URL.Path, Body: body})
}

func (f *fakeGraph) find(method, pathSuffix string) []fakeRequest {
	f.mx.Lock()
	defer f.mx.Unlock()
	var res []fakeRequest
	for _, r := range f.requests {
		if r.Method == method && strings.HasSuffix(r.Path, pathSuffix) {
			res = append(res, r)
		}
	}
	return res
}

func (f *fakeGraph) reset() {
	f.mx.Lock()
	defer f.mx.Unlock()
	f.requests = nil
}

// fakeReceiver records calls made by the sender.
type fakeReceiver struct {
	mx       sync.Mutex
	statuses map[string][]notification.Status
	results  []string
	stopped  []gadb.DestV1
}

func (r *fakeReceiver) SetMessageStatus(ctx context.Context, externalID string, status *notification.Status) error {
	r.mx.Lock()
	defer r.mx.Unlock()
	if r.statuses == nil {
		r.statuses = make(map[string][]notification.Status)
	}
	r.statuses[externalID] = append(r.statuses[externalID], *status)
	return nil
}

func (r *fakeReceiver) Receive(ctx context.Context, callbackID string, result notification.Result) error {
	r.mx.Lock()
	defer r.mx.Unlock()
	r.results = append(r.results, callbackID+":"+result.String())
	return nil
}

func (r *fakeReceiver) ReceiveSubject(ctx context.Context, providerID, subjectID, callbackID string, result notification.Result) error {
	return nil
}

func (r *fakeReceiver) AuthLinkURL(ctx context.Context, providerID, subjectID string, meta authlink.Metadata) (string, error) {
	return "", nil
}
func (r *fakeReceiver) Start(context.Context, gadb.DestV1) error { return nil }
func (r *fakeReceiver) Stop(ctx context.Context, d gadb.DestV1) error {
	r.mx.Lock()
	defer r.mx.Unlock()
	r.stopped = append(r.stopped, d)
	return nil
}
func (r *fakeReceiver) IsKnownDest(ctx context.Context, dest gadb.DestV1) (bool, error) {
	return true, nil
}

func testConfig() config.Config {
	var cfg config.Config
	cfg.General.PublicURL = "https://goalert.example.com"
	cfg.General.ApplicationName = "GoAlert"
	cfg.Teams.Enable = true
	cfg.Teams.TenantID = "tenant-id"
	cfg.Teams.ClientID = "client-id"
	cfg.Teams.ClientSecret = "client-secret"
	cfg.Teams.SpeechRegion = "eastus"
	cfg.Teams.SpeechKey = "speech-key"
	return cfg
}

func newTestSender(t *testing.T, f *fakeGraph) (*Sender, *fakeReceiver, context.Context) {
	s := NewSender(context.Background(), &Config{
		GraphBaseURL:  f.srv.URL,
		LoginBaseURL:  f.srv.URL,
		SpeechBaseURL: f.srv.URL,
		Client:        f.srv.Client(),
		Verifier: NotificationVerifierFunc(func(ctx context.Context, req *http.Request) error {
			if req.Header.Get("Authorization") != "Bearer valid" {
				return assert.AnError
			}
			return nil
		}),
	})
	r := &fakeReceiver{}
	s.SetReceiver(r)
	return s, r, testConfig().Context(context.Background())
}

func TestSender_SendMessage(t *testing.T) {
	f := newFakeGraph(t)
	s, _, ctx := newTestSender(t, f)

	msg := notification.Alert{
		Base:    nfymsg.Base{ID: "msg-1", Dest: NewCallDest("bob@contoso.com")},
		AlertID: 42,
		Summary: "Disk is full",
	}

	res, err := s.SendMessage(ctx, msg)
	require.NoError(t, err)
	assert.Equal(t, "call-1", res.ExternalID)
	assert.Equal(t, notification.StateSending, res.State)

	// UPN resolved to an object ID
	require.Len(t, f.find("GET", "/users/bob@contoso.com"), 1)

	calls := f.find("POST", "/communications/calls")
	require.Len(t, calls, 1)
	body := calls[0].Body
	assert.Equal(t, "tenant-id", body["tenantId"])
	assert.Equal(t, []interface{}{"audio"}, body["requestedModalities"])

	src := body["source"].(map[string]interface{})["identity"].(map[string]interface{})["application"].(map[string]interface{})
	assert.Equal(t, "client-id", src["id"])
	assert.Equal(t, "GoAlert", src["displayName"])

	targets := body["targets"].([]interface{})
	require.Len(t, targets, 1)
	user := targets[0].(map[string]interface{})["identity"].(map[string]interface{})["user"].(map[string]interface{})
	assert.Equal(t, "11111111-1111-1111-1111-111111111111", user["id"])

	cb, err := url.Parse(body["callbackUri"].(string))
	require.NoError(t, err)
	assert.Equal(t, "https", cb.Scheme)
	assert.Equal(t, callbackPath, cb.Path)
	assert.Equal(t, "msg-1", cb.Query().Get(paramMsgID))
	assert.Equal(t, string(kindAlert), cb.Query().Get(paramKind))
	assert.Equal(t, "bob@contoso.com", cb.Query().Get(paramUser))

	media := body["mediaConfig"].(map[string]interface{})
	assert.Equal(t, odataServiceHostedMedia, media["@odata.type"])
	prefetch := media["preFetchMedia"].([]interface{})
	require.Len(t, prefetch, 1)
	mediaURL, err := url.Parse(prefetch[0].(map[string]interface{})["uri"].(string))
	require.NoError(t, err)
	assert.Equal(t, mediaPath, mediaURL.Path)
	text, err := b64enc.DecodeString(mediaURL.Query().Get(mediaParamText))
	require.NoError(t, err)
	assert.Equal(t, "Hello! This is GoAlert with an alert notification. Disk is full. "+menuText(kindAlert), string(text))

	// a second call with the same user should use the cached lookup
	f.reset()
	_, err = s.SendMessage(ctx, msg)
	require.NoError(t, err)
	assert.Len(t, f.find("GET", "/users/bob@contoso.com"), 0)
}

func TestSender_SendMessage_Errors(t *testing.T) {
	f := newFakeGraph(t)
	s, _, ctx := newTestSender(t, f)

	// unknown user is a permanent failure
	res, err := s.SendMessage(ctx, notification.Test{Base: nfymsg.Base{ID: "m", Dest: NewCallDest("missing@contoso.com")}})
	require.NoError(t, err)
	assert.Equal(t, notification.StateFailedPerm, res.State)

	// unsupported message type
	_, err = s.SendMessage(ctx, notification.ScheduleOnCallUsers{Base: nfymsg.Base{ID: "m", Dest: NewCallDest("bob@contoso.com")}})
	require.Error(t, err)

	// provider disabled
	var cfg config.Config
	_, err = s.SendMessage(cfg.Context(context.Background()), notification.Test{Base: nfymsg.Base{ID: "m", Dest: NewCallDest("bob@contoso.com")}})
	require.Error(t, err)
}

func postNotification(t *testing.T, s *Sender, ctx context.Context, query url.Values, auth string, body string) int {
	t.Helper()
	req := httptest.NewRequest("POST", callbackPath+"?"+query.Encode(), strings.NewReader(body)).WithContext(ctx)
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	w := httptest.NewRecorder()
	s.ServeCallback(w, req)
	return w.Code
}

func callNotification(callID, state string, extra string) string {
	if extra != "" {
		extra = "," + extra
	}
	return `{"value":[{"changeType":"updated","resource":"/app/calls/` + callID + `","resourceUrl":"/communications/calls/` + callID + `","resourceData":{"@odata.type":"#microsoft.graph.call","state":"` + state + `"` + extra + `}}]}`
}

func promptNotification(callID, clientContext string) string {
	return `{"value":[{"changeType":"updated","resource":"/app/calls/` + callID + `/operations/op-1","resourceData":{"@odata.type":"#microsoft.graph.playPromptOperation","status":"completed","clientContext":"` + clientContext + `"}}]}`
}

func TestSender_ServeCallback_AckFlow(t *testing.T) {
	f := newFakeGraph(t)
	s, r, ctx := newTestSender(t, f)

	q := url.Values{paramMsgID: {"msg-1"}, paramKind: {string(kindAlert)}, paramUser: {"bob@contoso.com"}}

	// unauthenticated requests are rejected
	assert.Equal(t, 401, postNotification(t, s, ctx, q, "", callNotification("call-9", "ringing", "")))
	assert.Empty(t, r.statuses)

	// ringing -> sent
	assert.Equal(t, 202, postNotification(t, s, ctx, q, "Bearer valid", callNotification("call-9", "ringing", "")))
	require.Len(t, r.statuses["call-9"], 1)
	assert.Equal(t, notification.StateSent, r.statuses["call-9"][0].State)

	// established -> subscribe to tones + play the prompt (once)
	assert.Equal(t, 202, postNotification(t, s, ctx, q, "Bearer valid", callNotification("call-9", "established", "")))
	assert.Equal(t, 202, postNotification(t, s, ctx, q, "Bearer valid", callNotification("call-9", "established", "")))
	assert.Len(t, f.find("POST", "/communications/calls/call-9/subscribeToTone"), 1)
	prompts := f.find("POST", "/communications/calls/call-9/playPrompt")
	require.Len(t, prompts, 1)
	assert.Equal(t, ctxMainPrompt, prompts[0].Body["clientContext"])

	// user presses 4 -> acknowledged
	f.reset()
	assert.Equal(t, 202, postNotification(t, s, ctx, q, "Bearer valid", callNotification("call-9", "established", `"toneInfo":{"sequenceId":1,"tone":"tone4"}`)))
	assert.Equal(t, []string{"msg-1:ResultAcknowledge"}, r.results)
	assert.Len(t, f.find("POST", "/communications/calls/call-9/cancelMediaProcessing"), 1)
	prompts = f.find("POST", "/communications/calls/call-9/playPrompt")
	require.Len(t, prompts, 1)
	assert.Equal(t, ctxFinalPrompt, prompts[0].Body["clientContext"])

	// duplicate tone notification is ignored
	assert.Equal(t, 202, postNotification(t, s, ctx, q, "Bearer valid", callNotification("call-9", "established", `"toneInfo":{"sequenceId":1,"tone":"tone4"}`)))
	assert.Len(t, r.results, 1)

	// final prompt done -> hang up
	assert.Equal(t, 202, postNotification(t, s, ctx, q, "Bearer valid", promptNotification("call-9", ctxFinalPrompt)))
	assert.Len(t, f.find("DELETE", "/communications/calls/call-9"), 1)

	// terminated -> delivered
	assert.Equal(t, 202, postNotification(t, s, ctx, q, "Bearer valid", callNotification("call-9", "terminated", `"resultInfo":{"code":0,"subcode":0,"message":"ok"}`)))
	last := r.statuses["call-9"][len(r.statuses["call-9"])-1]
	assert.Equal(t, notification.StateDelivered, last.State)

	// status lookups after the call is gone use the recorded final state
	stat, err := s.MessageStatus(ctx, "gone")
	require.NoError(t, err)
	assert.Equal(t, notification.StateFailedPerm, stat.State)
	s.state("gone").final = &notification.Status{State: notification.StateDelivered}
	stat, err = s.MessageStatus(ctx, "gone")
	require.NoError(t, err)
	assert.Equal(t, notification.StateDelivered, stat.State)
}

func TestSender_ServeCallback_StopAndFailure(t *testing.T) {
	f := newFakeGraph(t)
	s, r, ctx := newTestSender(t, f)
	q := url.Values{paramMsgID: {"msg-2"}, paramKind: {string(kindTest)}, paramUser: {"bob@contoso.com"}}

	// press 1 then 3 -> unenrolled
	assert.Equal(t, 202, postNotification(t, s, ctx, q, "Bearer valid", callNotification("call-2", "established", `"toneInfo":{"sequenceId":1,"tone":"tone1"}`)))
	prompts := f.find("POST", "/communications/calls/call-2/playPrompt")
	require.Len(t, prompts, 1)
	assert.Equal(t, ctxStopPrompt, prompts[0].Body["clientContext"])

	assert.Equal(t, 202, postNotification(t, s, ctx, q, "Bearer valid", callNotification("call-2", "established", `"toneInfo":{"sequenceId":2,"tone":"tone3"}`)))
	require.Len(t, r.stopped, 1)
	assert.Equal(t, NewCallDest("bob@contoso.com"), r.stopped[0])
	assert.Empty(t, r.results)

	// unanswered call -> permanent failure; busy -> temporary failure
	assert.Equal(t, 202, postNotification(t, s, ctx, q, "Bearer valid", callNotification("call-3", "terminated", `"resultInfo":{"code":480,"subcode":10037,"message":"Temporarily Unavailable"}`)))
	assert.Equal(t, notification.StateFailedPerm, r.statuses["call-3"][0].State)
	assert.Contains(t, r.statuses["call-3"][0].Details, "Temporarily Unavailable")

	assert.Equal(t, 202, postNotification(t, s, ctx, q, "Bearer valid", callNotification("call-4", "terminated", `"resultInfo":{"code":486,"subcode":0,"message":"Busy Here"}`)))
	assert.Equal(t, notification.StateFailedTemp, r.statuses["call-4"][0].State)
}

func TestSender_ServeMedia(t *testing.T) {
	f := newFakeGraph(t)
	s, _, ctx := newTestSender(t, f)

	u, err := url.Parse(MediaURL(ctx, "Hello <world> & friends"))
	require.NoError(t, err)

	req := httptest.NewRequest("GET", u.RequestURI(), nil).WithContext(ctx)
	w := httptest.NewRecorder()
	s.ServeMedia(w, req)
	require.Equal(t, 200, w.Code)
	assert.Equal(t, "audio/wav", w.Header().Get("Content-Type"))
	assert.Equal(t, "RIFF-fake-wav", w.Body.String())

	tts := f.find("POST", "/cognitiveservices/v1")
	require.Len(t, tts, 1)
	assert.Contains(t, tts[0].Body["ssml"], `<voice name="en-US-JennyNeural">Hello &lt;world&gt; &amp; friends</voice>`)

	// tampered text is rejected
	q := u.Query()
	q.Set(mediaParamText, b64enc.EncodeToString([]byte("something else")))
	req = httptest.NewRequest("GET", u.Path+"?"+q.Encode(), nil).WithContext(ctx)
	w = httptest.NewRecorder()
	s.ServeMedia(w, req)
	assert.Equal(t, 403, w.Code)
}

func TestSender_Provider(t *testing.T) {
	s := NewSender(context.Background(), &Config{})
	ctx := testConfig().Context(context.Background())

	info, err := s.TypeInfo(ctx)
	require.NoError(t, err)
	assert.True(t, info.Enabled)
	assert.True(t, info.IsContactMethod())
	assert.False(t, info.IsEPTarget())

	assert.NoError(t, s.ValidateField(ctx, FieldUser, "bob@contoso.com"))
	assert.NoError(t, s.ValidateField(ctx, FieldUser, "11111111-1111-1111-1111-111111111111"))
	assert.Error(t, s.ValidateField(ctx, FieldUser, "bob"))
	assert.Error(t, s.ValidateField(ctx, "other", "x"))

	di, err := s.DisplayInfo(ctx, map[string]string{FieldUser: "bob@contoso.com"})
	require.NoError(t, err)
	assert.Equal(t, "bob@contoso.com", di.Text)
	assert.Equal(t, FallbackIconURL, di.IconURL)
}

func TestBuildSSML_Language(t *testing.T) {
	assert.Contains(t, buildSSML("es-MX-DaliaNeural", "hola"), `xml:lang="es-MX"`)
	assert.Contains(t, buildSSML("", "hi"), `xml:lang="en-US"`)
}
