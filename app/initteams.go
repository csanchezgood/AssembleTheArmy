package app

import (
	"context"

	"github.com/target/goalert/notification/teams"
)

func (app *App) initTeams(ctx context.Context) error {
	app.teamsCall = teams.NewSender(ctx, &teams.Config{
		GraphBaseURL: app.cfg.TeamsGraphBaseURL,
		Client:       app.httpClient,
	})

	return nil
}
