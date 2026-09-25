package teams

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/target/goalert/config"
	"github.com/target/goalert/util/log"
)

const (
	defaultVoiceName = "en-US-JennyNeural"

	// Service-hosted media requires single channel, 16-bit, 16 kHz WAV files.
	speechOutputFormat = "riff-16khz-16bit-mono-pcm"

	mediaParamText = "t"
	mediaParamSig  = "s"

	mediaPath = "/api/v2/teams/media"
)

// We use url encoding with no padding to keep the media URLs short and safe.
var b64enc = base64.URLEncoding.WithPadding(base64.NoPadding)

func (c *Config) speechBaseURL(cfg config.Config) string {
	if c.SpeechBaseURL != "" {
		return strings.TrimSuffix(c.SpeechBaseURL, "/")
	}
	return fmt.Sprintf("https://%s.tts.speech.microsoft.com", url.PathEscape(cfg.Teams.SpeechRegion))
}

func voiceLang(voiceName string) string {
	parts := strings.Split(voiceName, "-")
	if len(parts) < 2 {
		return "en-US"
	}
	return parts[0] + "-" + parts[1]
}

// buildSSML wraps the text in an SSML document for Azure AI Speech.
func buildSSML(voiceName, text string) string {
	if voiceName == "" {
		voiceName = defaultVoiceName
	}

	var buf bytes.Buffer
	_ = xml.EscapeText(&buf, []byte(text))

	return fmt.Sprintf(`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="%s"><voice name="%s">%s</voice></speak>`,
		voiceLang(voiceName), voiceName, buf.String())
}

// Synthesize converts text to a WAV audio file using Azure AI Speech.
func (c *Config) Synthesize(ctx context.Context, text string) ([]byte, error) {
	cfg := config.FromContext(ctx)
	if cfg.Teams.SpeechKey == "" {
		return nil, errors.New("Teams.SpeechKey is not configured")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.speechBaseURL(cfg)+"/cognitiveservices/v1", strings.NewReader(buildSSML(cfg.Teams.VoiceName, text)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Ocp-Apim-Subscription-Key", cfg.Teams.SpeechKey)
	req.Header.Set("Content-Type", "application/ssml+xml")
	req.Header.Set("X-Microsoft-OutputFormat", speechOutputFormat)
	req.Header.Set("User-Agent", "GoAlert")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("azure speech: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}

	// Limit to 8MB (a few minutes of 16kHz mono audio).
	return io.ReadAll(io.LimitReader(resp.Body, 8<<20))
}

func mediaSigningKey(cfg config.Config) []byte {
	sum := sha256.Sum256([]byte("goalert-teams-media\x00" + cfg.Teams.ClientSecret))
	return sum[:]
}

func signMedia(cfg config.Config, encodedText string) string {
	mac := hmac.New(sha256.New, mediaSigningKey(cfg))
	_, _ = mac.Write([]byte(encodedText))
	return b64enc.EncodeToString(mac.Sum(nil))
}

// MediaURL returns a signed, absolute URL that serves the spoken version of
// text. The text is embedded in the URL so no state needs to be stored, which
// keeps the provider safe to run across multiple GoAlert instances.
func MediaURL(ctx context.Context, text string) string {
	cfg := config.FromContext(ctx)
	enc := b64enc.EncodeToString([]byte(text))

	v := make(url.Values)
	v.Set(mediaParamText, enc)
	v.Set(mediaParamSig, signMedia(cfg, enc))

	return cfg.CallbackURL(mediaPath, v)
}

// ServeMedia serves synthesized audio for a signed media URL. Microsoft fetches
// this when pre-fetching call media and when playing prompts.
func (s *Sender) ServeMedia(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	cfg := config.FromContext(ctx)
	if !cfg.Teams.Enable {
		http.Error(w, http.StatusText(http.StatusForbidden), http.StatusForbidden)
		return
	}

	q := req.URL.Query()
	enc := q.Get(mediaParamText)
	sig := q.Get(mediaParamSig)
	if enc == "" || sig == "" || !hmac.Equal([]byte(sig), []byte(signMedia(cfg, enc))) {
		http.Error(w, "invalid or missing signature", http.StatusForbidden)
		return
	}

	text, err := b64enc.DecodeString(enc)
	if err != nil {
		http.Error(w, "invalid media text", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	data, err := s.c.Synthesize(ctx, string(text))
	if err != nil {
		log.Log(ctx, fmt.Errorf("synthesize teams call audio: %w", err))
		http.Error(w, http.StatusText(http.StatusBadGateway), http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, req, "prompt.wav", time.Time{}, bytes.NewReader(data))
}
