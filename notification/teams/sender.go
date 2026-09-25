package teams

import (
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

	"github.com/target/goalert/alert"
	"github.com/target/goalert/config"
	"github.com/target/goalert/notification"
	"github.com/target/goalert/notification/nfydest"
	"github.com/target/goalert/permission"
	"github.com/target/goalert/util/log"
	"github.com/target/goalert/validation"
)

const (
	callbackPath = "/api/v2/teams/callback"

	paramMsgID = "msgID"
	paramKind  = "kind"
	paramUser  = "user"

	// clientContext values echoed back in playPrompt notifications.
	ctxMainPrompt  = "main"
	ctxStopPrompt  = "stop"
	ctxFinalPrompt = "final"
	ctxRetryPrompt = "retry"

	// inputTimeout is how long the callee has to press a key after the menu
	// has been played before the call is ended.
	inputTimeout = 60 * time.Second

	// callStateTTL is how long per-call state is kept in memory after the call ends.
	callStateTTL = time.Hour

	graphTimeout = 15 * time.Second
)

var (
	_ notification.ReceiverSetter = (*Sender)(nil)
	_ nfydest.MessageSender       = (*Sender)(nil)
	_ nfydest.MessageStatuser     = (*Sender)(nil)
)

// Sender places Microsoft Teams calls (via Microsoft Graph) for notifications
// and processes the resulting call notifications (state changes and key presses).
type Sender struct {
	c *Config
	r notification.Receiver

	mx    sync.Mutex
	calls map[string]*callState
}

type callState struct {
	created time.Time

	msgID string
	kind  callKind
	user  string

	// mainPrompt is the spoken text of the notification (used to repeat it).
	mainPrompt string

	established bool
	prompted    bool
	pendingStop bool
	done        bool
	lastTone    int64

	final *notification.Status
}

// NewSender creates a Sender for Teams calls.
func NewSender(ctx context.Context, c *Config) *Sender {
	if c == nil {
		c = &Config{}
	}
	if c.Verifier == nil {
		c.Verifier = &BotFrameworkVerifier{Client: c.Client}
	}
	return &Sender{
		c:     c,
		calls: make(map[string]*callState),
	}
}

// SetReceiver sets the notification.Receiver for call responses and status updates.
func (s *Sender) SetReceiver(r notification.Receiver) { s.r = r }

func (s *Sender) callbackURL(ctx context.Context, msgID string, kind callKind, user string) string {
	cfg := config.FromContext(ctx)
	v := make(url.Values)
	v.Set(paramMsgID, msgID)
	v.Set(paramKind, string(kind))
	v.Set(paramUser, user)
	return cfg.CallbackURL(callbackPath, v)
}

func (s *Sender) state(callID string) *callState {
	s.mx.Lock()
	defer s.mx.Unlock()

	now := time.Now()
	for id, st := range s.calls {
		if now.Sub(st.created) > callStateTTL {
			delete(s.calls, id)
		}
	}

	st, ok := s.calls[callID]
	if !ok {
		st = &callState{created: now}
		s.calls[callID] = st
	}
	return st
}

// SendMessage implements nfydest.MessageSender by placing a Teams call.
func (s *Sender) SendMessage(ctx context.Context, msg notification.Message) (*notification.SentMessage, error) {
	cfg := config.FromContext(ctx)
	if !cfg.Teams.Enable {
		return nil, errors.New("Teams provider is disabled")
	}

	userRef := strings.TrimSpace(msg.DestArg(FieldUser))
	if userRef == "" {
		return &notification.SentMessage{State: notification.StateFailedPerm, StateDetails: "missing Teams user"}, nil
	}

	ctx = log.WithFields(ctx, log.Fields{
		"User": userRef,
		"Type": "TeamsCall",
	})

	kind, err := kindOf(msg)
	if err != nil {
		return nil, err
	}

	body, err := buildMessage(fmt.Sprintf("Hello! This is %s", cfg.ApplicationName()), msg)
	if err != nil {
		return nil, err
	}
	spoken := body + " " + menuText(kind)

	userID, err := s.c.ResolveUserID(ctx, userRef)
	if IsNotFound(err) {
		return &notification.SentMessage{State: notification.StateFailedPerm, StateDetails: "Teams user not found"}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolve Teams user: %w", err)
	}

	call, err := s.c.CreateCall(ctx,
		userID,
		s.callbackURL(ctx, msg.MsgID(), kind, userRef),
		MediaURL(ctx, spoken),
	)
	var gErr *GraphError
	if errors.As(err, &gErr) && gErr.StatusCode >= 400 && gErr.StatusCode < 500 && gErr.StatusCode != http.StatusTooManyRequests {
		// bad request/forbidden/etc. will not succeed on retry
		log.Log(ctx, fmt.Errorf("create Teams call: %w", err))
		return &notification.SentMessage{State: notification.StateFailedPerm, StateDetails: gErr.Error()}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("create Teams call: %w", err)
	}

	st := s.state(call.ID)
	st.msgID = msg.MsgID()
	st.kind = kind
	st.user = userRef
	st.mainPrompt = spoken

	stat := callStatus(call, false)
	return &notification.SentMessage{
		ExternalID:   call.ID,
		State:        stat.State,
		StateDetails: stat.Details,
	}, nil
}

// callStatus maps a Graph call resource to a notification status.
func callStatus(call *Call, wasEstablished bool) *notification.Status {
	var stat notification.Status
	stat.Details = call.State
	if call.ResultInfo != nil && call.ResultInfo.Message != "" {
		stat.Details = fmt.Sprintf("%s: [%d] %s", call.State, call.ResultInfo.Code, call.ResultInfo.Message)
	}

	switch call.State {
	case CallStateTerminated:
		code := 0
		if call.ResultInfo != nil {
			code = call.ResultInfo.Code
		}
		switch {
		case wasEstablished, code < 400:
			stat.State = notification.StateDelivered
		case code == 486: // busy here
			stat.State = notification.StateFailedTemp
		default:
			stat.State = notification.StateFailedPerm
		}
	case "", CallStateEstablishing:
		stat.State = notification.StateSending
	default:
		// ringing, established, hold, ...
		stat.State = notification.StateSent
	}

	return &stat
}

// MessageStatus implements nfydest.MessageStatuser.
func (s *Sender) MessageStatus(ctx context.Context, externalID string) (*notification.Status, error) {
	st := s.state(externalID)

	call, err := s.c.GetCall(ctx, externalID)
	if IsNotFound(err) {
		// Ended calls are removed by Microsoft Graph; use the final status we recorded, if any.
		if st.final != nil {
			return st.final, nil
		}
		return &notification.Status{State: notification.StateFailedPerm, Details: "call no longer exists; final status unknown"}, nil
	}
	if err != nil {
		return nil, err
	}

	return callStatus(call, st.established), nil
}

type commsNotification struct {
	ChangeType   string          `json:"changeType"`
	Resource     string          `json:"resource"`
	ResourceURL  string          `json:"resourceUrl"`
	ResourceData json.RawMessage `json:"resourceData"`
}

type commsNotifications struct {
	Value []commsNotification `json:"value"`
}

// ServeCallback handles call notifications from Microsoft Graph.
func (s *Sender) ServeCallback(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	cfg := config.FromContext(ctx)
	if !cfg.Teams.Enable {
		log.Log(ctx, errors.New("Teams provider is disabled"))
		http.Error(w, http.StatusText(http.StatusForbidden), http.StatusForbidden)
		return
	}

	err := s.c.Verifier.Verify(ctx, req)
	if err != nil {
		log.Log(ctx, fmt.Errorf("teams callback: %w", err))
		http.Error(w, http.StatusText(http.StatusUnauthorized), http.StatusUnauthorized)
		return
	}

	var payload commsNotifications
	err = json.NewDecoder(io.LimitReader(req.Body, 1<<20)).Decode(&payload)
	if err != nil {
		http.Error(w, "invalid notification body", http.StatusBadRequest)
		return
	}

	q := req.URL.Query()
	for _, n := range payload.Value {
		s.handleNotification(ctx, q, n)
	}

	w.WriteHeader(http.StatusAccepted)
}

// callIDFromResource extracts the call ID from a resource path like
// "/app/calls/{id}" or "/communications/calls/{id}/operations/{opID}".
func callIDFromResource(resource string) string {
	parts := strings.Split(strings.Trim(resource, "/"), "/")
	for i, p := range parts {
		if p == "calls" && i+1 < len(parts) {
			return parts[i+1]
		}
	}
	return ""
}

func (s *Sender) handleNotification(ctx context.Context, q url.Values, n commsNotification) {
	callID := callIDFromResource(n.Resource)
	if callID == "" {
		callID = callIDFromResource(n.ResourceURL)
	}
	if callID == "" {
		log.Log(ctx, fmt.Errorf("teams callback: unable to determine call ID from resource '%s'", n.Resource))
		return
	}

	var typ struct {
		ODataType string `json:"@odata.type"`
	}
	_ = json.Unmarshal(n.ResourceData, &typ)

	st := s.state(callID)
	if st.msgID == "" {
		st.msgID = q.Get(paramMsgID)
		st.kind = callKind(q.Get(paramKind))
		st.user = q.Get(paramUser)
	}

	ctx = log.WithFields(ctx, log.Fields{
		"CallID": callID,
		"User":   st.user,
		"Type":   "TeamsCall",
	})

	switch typ.ODataType {
	case odataCall:
		var call Call
		if err := json.Unmarshal(n.ResourceData, &call); err != nil {
			log.Log(ctx, fmt.Errorf("teams callback: parse call: %w", err))
			return
		}
		call.ID = callID
		s.handleCallUpdate(ctx, st, n.ChangeType, &call)
	case odataPlayPromptOp:
		var op PlayPromptOperation
		if err := json.Unmarshal(n.ResourceData, &op); err != nil {
			log.Log(ctx, fmt.Errorf("teams callback: parse playPrompt operation: %w", err))
			return
		}
		s.handlePromptDone(ctx, callID, st, &op)
	default:
		log.Debugf(ctx, "teams callback: ignoring notification for %s", typ.ODataType)
	}
}

func (s *Sender) setStatus(ctx context.Context, callID string, stat *notification.Status) {
	if s.r == nil {
		return
	}
	err := s.r.SetMessageStatus(ctx, callID, stat)
	if err != nil {
		log.Log(ctx, fmt.Errorf("update Teams call status: %w", err))
	}
}

func (s *Sender) handleCallUpdate(ctx context.Context, st *callState, changeType string, call *Call) {
	if call.ToneInfo != nil {
		s.handleTone(ctx, call.ID, st, call.ToneInfo)
		return
	}

	if changeType == "deleted" || call.State == CallStateTerminated {
		call.State = CallStateTerminated
		st.done = true
		st.final = callStatus(call, st.established)
		s.setStatus(ctx, call.ID, st.final)
		return
	}

	s.setStatus(ctx, call.ID, callStatus(call, st.established))

	if call.State != CallStateEstablished {
		return
	}
	st.established = true
	if st.prompted {
		return
	}
	st.prompted = true

	// Subscribe first so keys pressed while the message plays are not lost.
	err := s.c.SubscribeToTone(ctx, call.ID)
	if err != nil {
		log.Log(ctx, fmt.Errorf("subscribe to tones: %w", err))
	}

	s.playMain(ctx, call.ID, st)
}

func (s *Sender) playMain(ctx context.Context, callID string, st *callState) {
	text := st.mainPrompt
	if text == "" {
		// State was lost (e.g. restart); we can no longer repeat the notification.
		text = dashboardText
	}
	_, err := s.c.PlayPrompt(ctx, callID, ctxMainPrompt, MediaURL(ctx, text))
	if err != nil {
		log.Log(ctx, fmt.Errorf("play prompt: %w", err))
	}
}

// playFinal plays a closing message; the call is hung up once it finishes.
func (s *Sender) playFinal(ctx context.Context, callID string, text string) {
	_, err := s.c.PlayPrompt(ctx, callID, ctxFinalPrompt, MediaURL(ctx, text))
	if err != nil {
		log.Log(ctx, fmt.Errorf("play prompt: %w", err))
		s.hangUp(ctx, callID)
	}
}

func (s *Sender) hangUp(ctx context.Context, callID string) {
	err := s.c.HangUp(ctx, callID)
	if err != nil {
		log.Log(ctx, fmt.Errorf("hang up: %w", err))
	}
}

// backgroundContext returns a context, detached from the request, that still
// carries the config and logger for delayed work.
func backgroundContext(ctx context.Context) context.Context {
	cfg := config.FromContext(ctx)
	bg := log.FromContext(ctx).BackgroundContext()
	bg = permission.SystemContext(bg, "TeamsCall")
	return cfg.Context(bg)
}

func (s *Sender) handlePromptDone(ctx context.Context, callID string, st *callState, op *PlayPromptOperation) {
	if op.Status != "completed" && op.Status != "failed" {
		return
	}
	if op.Status == "failed" && op.ResultInfo != nil {
		log.Log(ctx, fmt.Errorf("teams prompt failed: [%d] %s", op.ResultInfo.Code, op.ResultInfo.Message))
	}

	switch op.ClientContext {
	case ctxFinalPrompt:
		s.hangUp(ctx, callID)
	case ctxMainPrompt, ctxStopPrompt, ctxRetryPrompt:
		if st.kind == kindVerify {
			// nothing to wait for
			s.hangUp(ctx, callID)
			return
		}

		// give the callee time to press a key, then end the call
		bg := backgroundContext(ctx)
		time.AfterFunc(inputTimeout, func() {
			if st.done {
				return
			}
			bg, cancel := context.WithTimeout(bg, graphTimeout)
			defer cancel()
			s.hangUp(bg, callID)
		})
	}
}

func (s *Sender) handleTone(ctx context.Context, callID string, st *callState, tone *ToneInfo) {
	if tone.SequenceID <= st.lastTone {
		// duplicate/out-of-order notification
		return
	}
	st.lastTone = tone.SequenceID

	if st.done {
		return
	}

	ctx = log.WithFields(ctx, log.Fields{"Tone": tone.Tone})

	// stop any prompt still playing so the response is heard immediately
	err := s.c.CancelMediaProcessing(ctx, callID)
	if err != nil {
		log.Debugf(ctx, "cancel media processing: %v", err)
	}

	if st.pendingStop {
		st.pendingStop = false
		switch tone.Tone {
		case toneConfirm:
			st.done = true
			err = s.doDeadline(ctx, func(ctx context.Context) error {
				return s.r.Stop(ctx, NewCallDest(st.user))
			})
			if err != nil {
				log.Log(ctx, fmt.Errorf("process STOP response: %w", err))
				s.playFinal(ctx, callID, "An error has occurred. Please use the dashboard to manage notifications.")
				return
			}
			s.playFinal(ctx, callID, "Unenrolled.")
		case toneGoBack:
			s.playMain(ctx, callID, st)
		default:
			s.playPrompt(ctx, callID, ctxStopPrompt, unknownDigitText+" "+stopConfirmText)
		}
		return
	}

	switch tone.Tone {
	case toneRepeat:
		s.playMain(ctx, callID, st)
		return
	case toneStop:
		if st.kind == kindVerify {
			break
		}
		st.pendingStop = true
		s.playPrompt(ctx, callID, ctxStopPrompt, stopConfirmText)
		return
	case toneAck, toneClose, toneEscalate:
		if st.kind != kindAlert && st.kind != kindAlertBundle {
			break
		}
		if tone.Tone == toneEscalate && st.kind == kindAlertBundle {
			break
		}

		var result notification.Result
		var msg string
		switch tone.Tone {
		case toneClose:
			result = notification.ResultResolve
			msg = "Closed"
		case toneEscalate:
			result = notification.ResultEscalate
			msg = "Escalation requested"
		default:
			result = notification.ResultAcknowledge
			msg = "Acknowledged"
		}
		if st.kind == kindAlertBundle {
			msg += " all alerts"
		}
		msg += "."

		st.done = true
		err = s.doDeadline(ctx, func(ctx context.Context) error {
			return s.r.Receive(ctx, st.msgID, result)
		})
		if err != nil {
			msg, err = voiceErrorMessage(ctx, err)
			if err != nil {
				log.Log(ctx, fmt.Errorf("process response: %w", err))
			}
		}
		s.playFinal(ctx, callID, msg)
		return
	}

	s.playPrompt(ctx, callID, ctxRetryPrompt, unknownDigitText+" "+menuText(st.kind))
}

func (s *Sender) playPrompt(ctx context.Context, callID, clientContext, text string) {
	_, err := s.c.PlayPrompt(ctx, callID, clientContext, MediaURL(ctx, text))
	if err != nil {
		log.Log(ctx, fmt.Errorf("play prompt: %w", err))
	}
}

func (s *Sender) doDeadline(ctx context.Context, fn func(context.Context) error) error {
	if s.r == nil {
		return errors.New("no receiver configured")
	}
	ctx, cancel := context.WithTimeout(ctx, graphTimeout)
	defer cancel()
	return fn(ctx)
}

// voiceErrorMessage converts a processing error into something that can be spoken to the user.
func voiceErrorMessage(ctx context.Context, err error) (string, error) {
	var e alert.LogEntryFetcher
	if errors.As(err, &e) {
		// we pass a 'sudo' context to give permission
		var msg string
		permission.SudoContext(ctx, func(sCtx context.Context) {
			entry, err := e.LogEntry(sCtx)
			if err != nil {
				log.Log(sCtx, fmt.Errorf("fetch log entry: %w", err))
			} else {
				msg = "Already " + rmParen.ReplaceAllString(entry.String(ctx), "") + "."
			}
		})
		if msg != "" {
			return msg, nil
		}
	}
	if alert.IsAlreadyClosed(err) {
		return "Alert is already closed.", nil
	}
	if alert.IsAlreadyAcknowledged(err) {
		return "Alert is already acknowledged.", nil
	}
	if validation.IsClientError(err) {
		return "Error: " + errors.Unwrap(err).Error(), nil
	}

	return "System error. Please visit the dashboard.", err
}
