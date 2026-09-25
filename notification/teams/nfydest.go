package teams

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/target/goalert/config"
	"github.com/target/goalert/gadb"
	"github.com/target/goalert/notification/nfydest"
	"github.com/target/goalert/validation"
	"github.com/target/goalert/validation/validate"
)

const (
	DestTypeTeamsCall = "builtin-teams-call"
	FieldUser         = "teams_user"
	FallbackIconURL   = "builtin://teams-call"
)

var _ nfydest.Provider = (*Sender)(nil)

// NewCallDest returns a destination for a Teams call to the given user (UPN/email or Entra object ID).
func NewCallDest(user string) gadb.DestV1 {
	return gadb.NewDestV1(DestTypeTeamsCall, FieldUser, user)
}

func (s *Sender) ID() string { return DestTypeTeamsCall }

func (s *Sender) TypeInfo(ctx context.Context) (*nfydest.TypeInfo, error) {
	cfg := config.FromContext(ctx)
	return &nfydest.TypeInfo{
		Type:                       DestTypeTeamsCall,
		Name:                       "Microsoft Teams Call",
		Enabled:                    cfg.Teams.Enable,
		UserDisclaimer:             cfg.General.NotificationDisclaimer,
		SupportsAlertNotifications: true,
		SupportsUserVerification:   true,
		SupportsStatusUpdates:      true,
		UserVerificationRequired:   true,
		RequiredFields: []nfydest.FieldConfig{{
			FieldID:            FieldUser,
			Label:              "Teams User",
			Hint:               "Work email / user principal name (e.g. user@contoso.com) or Microsoft Entra object ID",
			PlaceholderText:    "user@contoso.com",
			InputType:          "text",
			SupportsValidation: true,
		}},
	}, nil
}

func (s *Sender) ValidateField(ctx context.Context, fieldID, value string) error {
	switch fieldID {
	case FieldUser:
		value = strings.TrimSpace(value)
		if _, err := uuid.Parse(value); err == nil {
			return nil
		}
		return validate.Email(FieldUser, value)
	}

	return validation.NewGenericError("unknown field ID")
}

func (s *Sender) DisplayInfo(ctx context.Context, args map[string]string) (*nfydest.DisplayInfo, error) {
	if args == nil {
		args = make(map[string]string)
	}

	user := strings.TrimSpace(args[FieldUser])
	if user == "" {
		return nil, validation.NewGenericError("missing Teams user")
	}

	return &nfydest.DisplayInfo{
		IconURL:     FallbackIconURL,
		IconAltText: "Microsoft Teams Call",
		Text:        user,
	}, nil
}
