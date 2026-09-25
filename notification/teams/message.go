package teams

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/target/goalert/notification"
)

// callKind identifies what a call is about; it is carried on the callback URL
// so notifications can be handled without extra state.
type callKind string

const (
	kindAlert       = callKind("alert")
	kindAlertBundle = callKind("alert-bundle")
	kindAlertStatus = callKind("alert-status")
	kindTest        = callKind("test")
	kindVerify      = callKind("verify")
)

// DTMF tones (as reported by Microsoft Graph) mapped to actions. The digits
// match the ones GoAlert has always used for voice calls.
const (
	toneAck      = "tone4"
	toneEscalate = "tone5"
	toneClose    = "tone6"
	toneStop     = "tone1"
	toneGoBack   = "tone1"
	toneConfirm  = "tone3"
	toneRepeat   = "star"
)

var rmParen = regexp.MustCompile(`\s*\(.*?\)`)

func spellCode(code string) string {
	return strings.Join(strings.Split(code, ""), ". ")
}

func kindOf(msg notification.Message) (callKind, error) {
	switch msg.(type) {
	case notification.Alert:
		return kindAlert, nil
	case notification.AlertBundle:
		return kindAlertBundle, nil
	case notification.AlertStatus:
		return kindAlertStatus, nil
	case notification.Test:
		return kindTest, nil
	case notification.Verification:
		return kindVerify, nil
	}
	return "", fmt.Errorf("message type '%T' not supported", msg)
}

// buildMessage returns the spoken text for a notification.
func buildMessage(prefix string, msg notification.Message) (string, error) {
	if prefix == "" {
		return "", fmt.Errorf("buildMessage error: no prefix provided")
	}

	switch t := msg.(type) {
	case notification.AlertBundle:
		return fmt.Sprintf("%s with alert notifications. Service '%s' has %d unacknowledged alerts.", prefix, t.ServiceName, t.Count), nil
	case notification.Alert:
		if t.Summary == "" {
			t.Summary = "No summary provided"
		}
		return fmt.Sprintf("%s with an alert notification. %s.", prefix, t.Summary), nil
	case notification.AlertStatus:
		entry := rmParen.ReplaceAllString(t.LogEntry, "")
		return fmt.Sprintf("%s with a status update for alert '%s'. %s", prefix, t.Summary, entry), nil
	case notification.Test:
		return fmt.Sprintf("%s with a test message.", prefix), nil
	case notification.Verification:
		return fmt.Sprintf(
			"%s with your %d-digit verification code. The code is: %s. Again, your %d-digit verification code is: %s.",
			prefix, len(t.Code), spellCode(t.Code), len(t.Code), spellCode(t.Code),
		), nil
	}

	return "", fmt.Errorf("unhandled message type: %T", msg)
}

// menuText returns the spoken key-press options for a call kind.
func menuText(kind callKind) string {
	switch kind {
	case kindAlert:
		return "To acknowledge, press 4. To escalate, press 5. To close, press 6. To unenroll from all notifications, press 1. To repeat this message, press star."
	case kindAlertBundle:
		return "To acknowledge all, press 4. To close all, press 6. To unenroll from all notifications, press 1. To repeat this message, press star."
	case kindAlertStatus, kindTest:
		return "To unenroll from all notifications, press 1. To repeat this message, press star."
	case kindVerify:
		return "To repeat this message, press star."
	}
	return ""
}

const (
	stopConfirmText  = "Would you like to unenroll from all notifications? To confirm, press 3. To go back, press 1."
	unknownDigitText = "I am sorry. I didn't understand that."
	dashboardText    = "Please use the application dashboard to manage alerts."
)
