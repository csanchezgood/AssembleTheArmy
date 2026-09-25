# Microsoft Teams voice calls

This fork replaces Twilio voice calls with calls to Microsoft Teams users. SMS
still goes through Twilio. Calls are placed with the
[Microsoft Graph cloud communications API](https://learn.microsoft.com/graph/api/resources/communications-api-overview)
and the spoken message is generated with Azure AI Speech (text-to-speech).

The contact method type is **Microsoft Teams Call** (`builtin-teams-call`). The
user enters their work email / user principal name (or Entra object ID); GoAlert
resolves it to the Entra user and rings them in Teams.

## How a call works

1. GoAlert creates a call (`POST /communications/calls`) with a `callbackUri`
   pointing at `/api/v2/teams/callback` and a pre-fetched WAV prompt served from
   `/api/v2/teams/media`. Media URLs are signed, and contain the text to speak,
   so no state is shared between GoAlert instances.
2. When the call is `established`, GoAlert subscribes to DTMF tones and plays
   the notification followed by the menu.
3. Key presses are the same as the old Twilio flow:
   `4` acknowledge, `5` escalate, `6` close, `1` (then `3` to confirm) unenroll,
   `*` repeat.
4. The result is spoken back and the call is hung up. If nothing is pressed
   within 60 seconds the call is ended.
5. `terminated` notifications update the message status (delivered / failed).

Verification codes, test messages and alert status updates are also spoken.

## Azure setup

1. **App registration** (Microsoft Entra ID)
   - Create an app registration; note the *Tenant ID* and *Application (client) ID*.
   - Create a client secret.
   - Add **application** permissions for Microsoft Graph and grant admin consent:
     - `Calls.Initiate.All` (place 1:1 calls)
     - `User.Read.All` (resolve user principal names to object IDs)
2. **Azure Bot**
   - Create an *Azure Bot* resource using the app registration above
     (Type: Multi Tenant or Single Tenant to match the registration).
   - Under *Channels*, add **Microsoft Teams**, open the *Calling* tab, enable
     calling and set the webhook to the value shown in the GoAlert admin page
     hint `Teams.CallbackURL` (`https://<public-url>/api/v2/teams/callback`).
3. **Azure AI Speech**
   - Create a *Speech* resource; note its *region* (e.g. `eastus`) and a key.

Microsoft must be able to reach GoAlert's public URL over HTTPS for both the
callback and the media endpoints.

## GoAlert configuration

In *Admin → Config*:

| Key | Value |
| --- | --- |
| `Teams.Enable` | `true` |
| `Teams.TenantID` | Entra tenant ID |
| `Teams.ClientID` | Application (client) ID |
| `Teams.ClientSecret` | Client secret |
| `Teams.DisplayName` | Optional caller name (defaults to the application name) |
| `Teams.SpeechRegion` | Speech resource region, e.g. `eastus` |
| `Teams.SpeechKey` | Speech resource key |
| `Teams.VoiceName` | Optional neural voice, e.g. `es-MX-DaliaNeural` (default `en-US-JennyNeural`) |

For local testing against a mock, the Graph endpoint can be overridden with the
`--teams-graph-base-url` flag.

## Notes and limitations

- Incoming notifications are authenticated by validating the Bot Framework
  bearer token (issuer `https://api.botframework.com`, audience = client ID).
- Per-call state (which message a call belongs to, whether it was answered) is
  kept in memory for one hour. If GoAlert restarts during a call, the caller
  can still hang up but the alert text cannot be repeated with `*`.
- The old `/api/v2/twilio/call` endpoints and the `builtin-twilio-voice`
  destination type are no longer registered; existing voice contact methods
  will not receive calls and should be re-created as Teams calls.
